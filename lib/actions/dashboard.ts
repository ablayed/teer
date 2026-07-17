'use server';

import { authActionClient } from '@/lib/actions/safe-action';
import { buildDashboardCashCollectedByProduct } from '@/lib/dashboard/cash-by-product';
import { type SupabaseServerClient, getCachedDashboardContext } from '@/lib/dashboard/context';
import {
  type DashboardRevenue30d,
  type DashboardRevenuePoint,
  type Revenue30dOrder,
  aggregateRevenue30d,
  normalizeCurrency,
  revenue30dLowerBound,
} from '@/lib/dashboard/revenue-30d';
import { type OrderStatus, orderStatuses } from '@/lib/domain/order-state-machine';
import { fetchAllPages, fetchFinanceCollectedJoins } from '@/lib/finance/finance-joins';
import type { FinanceRevenueByProductRow } from '@/lib/finance/product-cost';
import { createFinanceAdminClient } from '@/lib/finance/report-data';
import { PERIOD_PRESETS, resolvePeriodRange } from '@/lib/periods/date-range';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { z } from 'zod';

type DashboardKpiRpcPayload = Record<string, unknown>;
const dashboardShopFilterSchema = z
  .object({
    shopId: z.string().uuid().nullable().optional(),
  })
  .optional();
const dashboardPeriodSchema = z.object({
  from: z.string().datetime(),
  shopId: z.string().uuid().nullable().optional(),
  to: z.string().datetime(),
});

export type DashboardKpi = {
  a_appeler_count: number;
  a_appeler_delta: number;
  ca_en_attente: number;
  currency: string | null;
  taux_confirmation: number;
  taux_livraison: number;
};

export type DashboardKpiActionResult =
  | { ok: true; data: DashboardKpi }
  | { ok: false; errorCode: 'not_found' | 'rpc_error' };

export type { DashboardRevenue30d, DashboardRevenuePoint };

export type DashboardRevenue30dActionResult =
  | { ok: true; data: DashboardRevenue30d }
  | { ok: false; errorCode: 'not_found' | 'query_error' };

export type DashboardTopProduct = {
  name: string;
  revenue: number;
  units: number;
};

export type DashboardShopPerformance = {
  id: string;
  name: string;
  status: string;
  ordersCount: number;
  revenue: number;
};

export type DashboardCodBreakdownItem = {
  count: number;
  status: OrderStatus;
};

export type DashboardRecentActivityItem = {
  createdAt: string;
  fromStatus: OrderStatus | null;
  id: string;
  orderNumber: string | null;
  toStatus: OrderStatus;
};

export type DashboardAlert = {
  count: number;
  id: string;
  kind: 'lateCalls' | 'shops' | 'tokens';
  tone: 'danger' | 'warning';
};

// Compteurs de la section Tableau « Priorités à traiter ». Chaque compteur est borné aux
// 7 derniers jours sur le même champ que sa liste-cible /commandes?vue=<id>&period=7j :
// aAppeler → orders.created_at (aligné get_dashboard_kpi 0076) ; enLivraison /
// annuleesRetours → dernière order_state_transition.to_status pertinente (pas de date de
// commande fiable pour ces 2 lignes, cf. diagnostic Tableau « Priorités à traiter »).
export type DashboardPriorityCounts = {
  aAppeler: number;
  aRappeler: number;
  enLivraison: number;
  annuleesRetours: number;
};

export type DashboardCashCollectedTotal = {
  caMinor: number;
};

export type DashboardCashCollectedByProduct = {
  items: FinanceRevenueByProductRow[];
  totalMinor: number;
};

export type DashboardDeliveriesByProductItem = {
  deliveredOrdersCount: number;
  productId: string;
  title: string;
};

export type DashboardDeliveriesByProduct = {
  products: DashboardDeliveriesByProductItem[];
  totalDeliveries: number;
};

export type DashboardReadonlyActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; errorCode: 'not_found' | 'query_error' };

function asTypedSupabaseClient(client: unknown): SupabaseServerClient {
  return client as SupabaseServerClient;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOrderStatus(value: string | null): value is OrderStatus {
  return value !== null && orderStatuses.includes(value as OrderStatus);
}

function numberFromRpc(value: unknown): number {
  const numericValue = Number(value ?? 0);

  return Number.isFinite(numericValue) ? numericValue : 0;
}

function firstRpcRow(value: unknown): DashboardKpiRpcPayload | null {
  const row = Array.isArray(value) ? value[0] : value;

  return isRecord(row) ? row : null;
}

function toDashboardKpi(row: DashboardKpiRpcPayload, currency: string | null): DashboardKpi {
  return {
    a_appeler_count: numberFromRpc(row.a_appeler_count),
    a_appeler_delta: numberFromRpc(row.a_appeler_delta),
    ca_en_attente: numberFromRpc(row.ca_en_attente),
    currency,
    taux_confirmation: numberFromRpc(row.taux_confirmation),
    taux_livraison: numberFromRpc(row.taux_livraison),
  };
}

async function getMerchantAccountIdForUser({
  supabase,
  userId,
}: {
  supabase: SupabaseServerClient;
  userId: string;
}): Promise<{ ok: true; merchantAccountId: string } | { ok: false }> {
  const { data: member, error } = await supabase
    .from('merchant_member')
    .select('merchant_account_id')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();

  if (error || !member) {
    return { ok: false };
  }

  return { ok: true, merchantAccountId: member.merchant_account_id };
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];

  return typeof value === 'string' ? value : null;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  const numericValue = Number(value ?? 0);

  return Number.isFinite(numericValue) ? numericValue : 0;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toDashboardDeliveriesByProduct(
  value: unknown,
): DashboardReadonlyActionResult<DashboardDeliveriesByProduct> {
  if (!isRecord(value)) {
    return { ok: false, errorCode: 'query_error' };
  }

  const products = asRecordArray(value.products)
    .map((row) => {
      const productId = stringOrNull(row.product_id);
      const title = stringOrNull(row.title);

      if (!productId || !title) {
        return null;
      }

      return {
        deliveredOrdersCount: numberField(row, 'delivered_orders_count'),
        productId,
        title,
      } satisfies DashboardDeliveriesByProductItem;
    })
    .filter((row): row is DashboardDeliveriesByProductItem => row !== null);

  return {
    ok: true,
    data: {
      products,
      totalDeliveries: numberField(value, 'total_deliveries'),
    },
  };
}

async function fetchTopProductsForUser({
  from,
  merchantAccountId,
  shopId,
  supabase,
  to,
}: {
  from: Date;
  merchantAccountId: string;
  shopId?: string | null;
  supabase: SupabaseServerClient;
  to: Date;
}): Promise<DashboardReadonlyActionResult<DashboardTopProduct[]>> {
  // Agrégation SQL non plafonnée (RPC 0080). L'ancienne version parsait items_summary côté JS
  // sur les 500 commandes les plus récentes (.limit(500)) → top faux. La RPC agrège
  // items_summary sur tout le périmètre (mêmes 4 statuts) et renvoie le top 5 déjà trié.
  const { data, error } = await supabase.rpc('get_dashboard_top_products', {
    p_from: from.toISOString(),
    p_merchant_id: merchantAccountId,
    ...(shopId ? { p_shop_id: shopId } : {}),
    p_to: to.toISOString(),
  });

  if (error) {
    return { ok: false, errorCode: 'query_error' };
  }

  return {
    ok: true,
    data: asRecordArray(data)
      .map((row) => ({
        name: stringField(row, 'name') ?? '',
        units: numberField(row, 'units'),
        revenue: numberField(row, 'revenue'),
      }))
      .filter((product) => product.name !== ''),
  };
}

async function fetchShopPerformanceForUser({
  from,
  merchantAccountId,
  shopId,
  supabase,
  to,
}: {
  from: Date;
  merchantAccountId: string;
  shopId?: string | null;
  supabase: SupabaseServerClient;
  to: Date;
}): Promise<DashboardReadonlyActionResult<DashboardShopPerformance[]>> {
  // Agrégation SQL non plafonnée (RPC 0080). L'ancienne version rapatriait orders(shop_id,
  // total_amount) sans .limit → tronqué à 1000 (max_rows) → « 1000 commandes » pile. La RPC
  // compte/somme par boutique côté SQL sur la période sélectionnée (sans filtre de statut), LEFT JOIN shop →
  // boutiques à 0 incluses, ordre installed_at asc (sémantique identique, chiffres exacts).
  const { data, error } = await supabase.rpc('get_dashboard_shop_performance', {
    p_from: from.toISOString(),
    p_merchant_id: merchantAccountId,
    ...(shopId ? { p_shop_id: shopId } : {}),
    p_to: to.toISOString(),
  });

  if (error) {
    return { ok: false, errorCode: 'query_error' };
  }

  return {
    ok: true,
    data: asRecordArray(data).map((row) => ({
      id: stringField(row, 'id') ?? '',
      name: stringField(row, 'name') ?? '',
      status: stringField(row, 'status') ?? '',
      ordersCount: numberField(row, 'orders_count'),
      revenue: numberField(row, 'revenue'),
    })),
  };
}

async function fetchCodBreakdownForUser({
  from,
  merchantAccountId,
  shopId,
  supabase,
  to,
}: {
  from: Date;
  merchantAccountId: string;
  shopId?: string | null;
  supabase: SupabaseServerClient;
  to: Date;
}): Promise<DashboardReadonlyActionResult<DashboardCodBreakdownItem[]>> {
  // Agrégation SQL non plafonnée (RPC 0080). L'ancienne version rapatriait orders(cod_status)
  // sans .limit → tronqué à 1000 (max_rows) → « À appeler 1000 / reste 0 ». La RPC compte
  // par cod_status côté SQL sur la période sélectionnée. On remappe sur orderStatuses (8 catégories, 0 par
  // défaut) → contrat UI inchangé.
  const { data, error } = await supabase.rpc('get_dashboard_cod_breakdown', {
    p_from: from.toISOString(),
    p_merchant_id: merchantAccountId,
    ...(shopId ? { p_shop_id: shopId } : {}),
    p_to: to.toISOString(),
  });

  if (error) {
    return { ok: false, errorCode: 'query_error' };
  }

  const counts = new Map<OrderStatus, number>(orderStatuses.map((status) => [status, 0]));

  for (const row of asRecordArray(data)) {
    const status = stringField(row, 'cod_status');
    if (isOrderStatus(status)) {
      counts.set(status, numberField(row, 'count'));
    }
  }

  return {
    ok: true,
    data: orderStatuses.map((status) => ({ status, count: counts.get(status) ?? 0 })),
  };
}

async function fetchRecentActivityForUser({
  merchantAccountId,
  shopId,
  supabase,
}: {
  merchantAccountId: string;
  shopId?: string | null;
  supabase: SupabaseServerClient;
}): Promise<DashboardReadonlyActionResult<DashboardRecentActivityItem[]>> {
  const { data, error } = await supabase
    .from('order_state_transition')
    .select('id, created_at, from_status, to_status, order:order_id(order_number, shop_id)')
    .eq('merchant_account_id', merchantAccountId)
    .order('created_at', { ascending: false })
    .limit(shopId ? 40 : 8);

  if (error) {
    return { ok: false, errorCode: 'query_error' };
  }

  return {
    ok: true,
    data: (data ?? [])
      .filter((item) => !shopId || item.order?.shop_id === shopId)
      .slice(0, 8)
      .map((item) => {
        const toStatus = isOrderStatus(item.to_status) ? item.to_status : null;

        if (!toStatus) {
          return null;
        }

        return {
          id: item.id,
          createdAt: item.created_at,
          fromStatus: isOrderStatus(item.from_status) ? item.from_status : null,
          orderNumber: item.order?.order_number ?? null,
          toStatus,
        };
      })
      .filter((item): item is DashboardRecentActivityItem => item !== null),
  };
}

async function fetchAlertsForUser({
  supabase,
  userId,
}: {
  supabase: SupabaseServerClient;
  userId: string;
}): Promise<DashboardReadonlyActionResult<DashboardAlert[]>> {
  const merchant = await getMerchantAccountIdForUser({ supabase, userId });

  if (!merchant.ok) {
    return { ok: false, errorCode: 'not_found' };
  }

  const olderThan = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const tokenExpiryThreshold = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const [lateOrdersResult, shopResult, tokenResult] = await Promise.all([
    supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('merchant_account_id', merchant.merchantAccountId)
      .eq('cod_status', 'A_APPELER')
      .lt('created_at', olderThan),
    supabase
      .from('shop')
      .select('id', { count: 'exact', head: true })
      .eq('merchant_account_id', merchant.merchantAccountId)
      .neq('status', 'connected'),
    supabase
      .from('shop')
      .select('id', { count: 'exact', head: true })
      .eq('merchant_account_id', merchant.merchantAccountId)
      .not('access_token_expires_at', 'is', null)
      .lt('access_token_expires_at', tokenExpiryThreshold),
  ]);

  if (lateOrdersResult.error || shopResult.error || tokenResult.error) {
    return { ok: false, errorCode: 'query_error' };
  }

  const alerts: DashboardAlert[] = [];
  const lateOrderCount = lateOrdersResult.count ?? 0;
  const shopIssueCount = shopResult.count ?? 0;
  const tokenIssueCount = tokenResult.count ?? 0;

  if (lateOrderCount > 0) {
    alerts.push({
      count: lateOrderCount,
      id: 'late-calls',
      kind: 'lateCalls',
      tone: 'warning',
    });
  }

  if (shopIssueCount > 0) {
    alerts.push({
      count: shopIssueCount,
      id: 'shops',
      kind: 'shops',
      tone: 'danger',
    });
  }

  if (tokenIssueCount > 0) {
    alerts.push({
      count: tokenIssueCount,
      id: 'tokens',
      kind: 'tokens',
      tone: 'warning',
    });
  }

  return { ok: true, data: alerts };
}

// PostgREST plafonne silencieusement toute requête sans .range()/.limit() à
// max_rows=1000 (supabase/config.toml:8). Sans borne, ce select all-time (`.limit(5000)`
// inopérant au-delà de max_rows) tronque aux 1000 LIVREE les plus récentes par created_at →
// graphe 30j faux dès qu'un tenant dépasse 1000 commandes livrées cumulées (Lot perf 2, H3).
// `revenue30dLowerBound` borne sur created_at (sûr car created_at ≥ created_at_shopify),
// puis boucle .range() pour rester exact même si la fenêtre élargie dépasse 1000 lignes
// sur un très gros tenant.
const REVENUE_30D_PAGE_SIZE = 500;

async function fetchRevenue30dForUser({
  merchantAccountId,
  shopId,
  supabase,
}: {
  merchantAccountId: string;
  shopId?: string | null;
  supabase: SupabaseServerClient;
}): Promise<DashboardRevenue30dActionResult> {
  const lowerBound = revenue30dLowerBound();
  const orders: Revenue30dOrder[] = [];

  for (let offset = 0; ; offset += REVENUE_30D_PAGE_SIZE) {
    let query = supabase
      .from('orders')
      .select('created_at, created_at_shopify, currency, total_amount')
      .eq('merchant_account_id', merchantAccountId)
      .eq('cod_status', 'LIVREE')
      .gte('created_at', lowerBound);

    if (shopId) {
      query = query.eq('shop_id', shopId);
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(offset, offset + REVENUE_30D_PAGE_SIZE - 1);

    if (error) {
      return { ok: false, errorCode: 'query_error' };
    }

    const batch = data ?? [];
    orders.push(...batch);

    if (batch.length < REVENUE_30D_PAGE_SIZE) {
      break;
    }
  }

  return { ok: true, data: aggregateRevenue30d(orders) };
}

async function fetchDashboardKpiForUser({
  merchantAccountId,
  shopId,
  supabase,
}: {
  merchantAccountId: string;
  shopId?: string | null;
  supabase: SupabaseServerClient;
}): Promise<DashboardKpiActionResult> {
  let currencyQuery = supabase
    .from('orders')
    .select('currency')
    .eq('merchant_account_id', merchantAccountId)
    .not('currency', 'is', null);

  if (shopId) {
    currencyQuery = currencyQuery.eq('shop_id', shopId);
  }

  const [kpiResult, currencyResult] = await Promise.all([
    supabase.rpc('get_dashboard_kpi', {
      p_merchant_id: merchantAccountId,
      ...(shopId ? { p_shop_id: shopId } : {}),
    }),
    currencyQuery.limit(1).maybeSingle(),
  ]);

  const { data, error } = kpiResult;

  if (error) {
    return { ok: false, errorCode: 'rpc_error' };
  }

  const row = firstRpcRow(data);

  if (!row) {
    return { ok: false, errorCode: 'not_found' };
  }

  return {
    ok: true,
    data: toDashboardKpi(
      row,
      currencyResult.error ? null : normalizeCurrency(currencyResult.data?.currency),
    ),
  };
}

// QW4 — les fonctions ci-dessous (consommées par /tableau) résolvaient chacune leur propre
// auth.getUser() + merchant_member (9 résolutions indépendantes par rendu de page, cf.
// lib/dashboard/context.ts). getCachedDashboardContext() est request-scoped (React.cache) :
// une seule résolution identité/membre est réellement exécutée, partagée par toutes ces
// fonctions ET par app/(app)/tableau/page.tsx. Les *Action (next-safe-action) restent
// inchangées dans leur comportement : elles ne participent pas au rendu /tableau (invocations
// séparées) et résolvent merchantAccountId via getMerchantAccountIdForUser comme avant, juste
// déplacé hors de fetchXForUser (devenue privée à merchantAccountId déjà résolu).
export async function getDashboardKpi(shopId?: string | null): Promise<DashboardKpiActionResult> {
  const ctx = await getCachedDashboardContext();

  if (!ctx.ok) {
    return {
      ok: false,
      errorCode: ctx.errorCode === 'member_query_error' ? 'rpc_error' : 'not_found',
    };
  }

  return fetchDashboardKpiForUser({
    merchantAccountId: ctx.merchantAccountId,
    shopId,
    supabase: ctx.supabase,
  });
}

export const getDashboardKpiAction = authActionClient
  .metadata({ actionName: 'dashboard.get_kpi', section: 'dashboard' })
  .inputSchema(dashboardShopFilterSchema)
  .action(async ({ ctx, parsedInput }): Promise<DashboardKpiActionResult> => {
    const supabase = asTypedSupabaseClient(ctx.supabase);
    // Distinction préservée à l'identique de l'ancienne fetchDashboardKpiForUser :
    // erreur de requête → rpc_error, membre absent → not_found.
    const { data: member, error: memberError } = await supabase
      .from('merchant_member')
      .select('merchant_account_id')
      .eq('user_id', ctx.user.id)
      .limit(1)
      .maybeSingle();

    if (memberError) {
      return { ok: false, errorCode: 'rpc_error' };
    }
    if (!member) {
      return { ok: false, errorCode: 'not_found' };
    }

    return fetchDashboardKpiForUser({
      merchantAccountId: member.merchant_account_id,
      shopId: parsedInput?.shopId ?? null,
      supabase,
    });
  });

export async function getRevenue30d(
  shopId?: string | null,
): Promise<DashboardRevenue30dActionResult> {
  const ctx = await getCachedDashboardContext();

  if (!ctx.ok) {
    return { ok: false, errorCode: 'not_found' };
  }

  return fetchRevenue30dForUser({
    merchantAccountId: ctx.merchantAccountId,
    shopId,
    supabase: ctx.supabase,
  });
}

export const getRevenue30dAction = authActionClient
  .metadata({ actionName: 'dashboard.get_revenue_30d', section: 'dashboard' })
  .action(async ({ ctx }): Promise<DashboardRevenue30dActionResult> => {
    const supabase = asTypedSupabaseClient(ctx.supabase);
    const merchant = await getMerchantAccountIdForUser({ supabase, userId: ctx.user.id });

    if (!merchant.ok) {
      return { ok: false, errorCode: 'not_found' };
    }

    return fetchRevenue30dForUser({ merchantAccountId: merchant.merchantAccountId, supabase });
  });

export async function getTopProducts({
  from,
  shopId,
  to,
}: {
  from: Date;
  shopId?: string | null;
  to: Date;
}): Promise<DashboardReadonlyActionResult<DashboardTopProduct[]>> {
  const ctx = await getCachedDashboardContext();

  if (!ctx.ok) {
    return { ok: false, errorCode: 'not_found' };
  }

  return fetchTopProductsForUser({
    from,
    merchantAccountId: ctx.merchantAccountId,
    shopId,
    supabase: ctx.supabase,
    to,
  });
}

export const getTopProductsAction = authActionClient
  .metadata({ actionName: 'dashboard.get_top_products', section: 'dashboard' })
  .inputSchema(dashboardPeriodSchema)
  .action(
    async ({ ctx, parsedInput }): Promise<DashboardReadonlyActionResult<DashboardTopProduct[]>> => {
      const supabase = asTypedSupabaseClient(ctx.supabase);
      const merchant = await getMerchantAccountIdForUser({ supabase, userId: ctx.user.id });

      if (!merchant.ok) {
        return { ok: false, errorCode: 'not_found' };
      }

      return fetchTopProductsForUser({
        from: new Date(parsedInput.from),
        merchantAccountId: merchant.merchantAccountId,
        shopId: parsedInput.shopId,
        supabase,
        to: new Date(parsedInput.to),
      });
    },
  );

export async function getShopPerformance({
  from,
  shopId,
  to,
}: {
  from: Date;
  shopId?: string | null;
  to: Date;
}): Promise<DashboardReadonlyActionResult<DashboardShopPerformance[]>> {
  const ctx = await getCachedDashboardContext();

  if (!ctx.ok) {
    return { ok: false, errorCode: 'not_found' };
  }

  return fetchShopPerformanceForUser({
    from,
    merchantAccountId: ctx.merchantAccountId,
    shopId,
    supabase: ctx.supabase,
    to,
  });
}

export const getShopPerformanceAction = authActionClient
  .metadata({ actionName: 'dashboard.get_shop_performance', section: 'dashboard' })
  .inputSchema(dashboardPeriodSchema)
  .action(
    async ({
      ctx,
      parsedInput,
    }): Promise<DashboardReadonlyActionResult<DashboardShopPerformance[]>> => {
      const supabase = asTypedSupabaseClient(ctx.supabase);
      const merchant = await getMerchantAccountIdForUser({ supabase, userId: ctx.user.id });

      if (!merchant.ok) {
        return { ok: false, errorCode: 'not_found' };
      }

      return fetchShopPerformanceForUser({
        from: new Date(parsedInput.from),
        merchantAccountId: merchant.merchantAccountId,
        shopId: parsedInput.shopId,
        supabase,
        to: new Date(parsedInput.to),
      });
    },
  );

export async function getCodBreakdown({
  from,
  shopId,
  to,
}: {
  from: Date;
  shopId?: string | null;
  to: Date;
}): Promise<DashboardReadonlyActionResult<DashboardCodBreakdownItem[]>> {
  const ctx = await getCachedDashboardContext();

  if (!ctx.ok) {
    return { ok: false, errorCode: 'not_found' };
  }

  return fetchCodBreakdownForUser({
    from,
    merchantAccountId: ctx.merchantAccountId,
    shopId,
    supabase: ctx.supabase,
    to,
  });
}

export const getCodBreakdownAction = authActionClient
  .metadata({ actionName: 'dashboard.get_cod_breakdown', section: 'dashboard' })
  .inputSchema(dashboardPeriodSchema)
  .action(
    async ({
      ctx,
      parsedInput,
    }): Promise<DashboardReadonlyActionResult<DashboardCodBreakdownItem[]>> => {
      const supabase = asTypedSupabaseClient(ctx.supabase);
      const merchant = await getMerchantAccountIdForUser({ supabase, userId: ctx.user.id });

      if (!merchant.ok) {
        return { ok: false, errorCode: 'not_found' };
      }

      return fetchCodBreakdownForUser({
        from: new Date(parsedInput.from),
        merchantAccountId: merchant.merchantAccountId,
        shopId: parsedInput.shopId,
        supabase,
        to: new Date(parsedInput.to),
      });
    },
  );

export async function getRecentActivity(
  shopId?: string | null,
): Promise<DashboardReadonlyActionResult<DashboardRecentActivityItem[]>> {
  const ctx = await getCachedDashboardContext();

  if (!ctx.ok) {
    return { ok: false, errorCode: 'not_found' };
  }

  return fetchRecentActivityForUser({
    merchantAccountId: ctx.merchantAccountId,
    shopId,
    supabase: ctx.supabase,
  });
}

export const getRecentActivityAction = authActionClient
  .metadata({ actionName: 'dashboard.get_recent_activity', section: 'dashboard' })
  .action(
    async ({ ctx }): Promise<DashboardReadonlyActionResult<DashboardRecentActivityItem[]>> => {
      const supabase = asTypedSupabaseClient(ctx.supabase);
      const merchant = await getMerchantAccountIdForUser({ supabase, userId: ctx.user.id });

      if (!merchant.ok) {
        return { ok: false, errorCode: 'not_found' };
      }

      return fetchRecentActivityForUser({
        merchantAccountId: merchant.merchantAccountId,
        supabase,
      });
    },
  );

export async function getAlerts(): Promise<DashboardReadonlyActionResult<DashboardAlert[]>> {
  const supabase = asTypedSupabaseClient(await createSupabaseServerClient());
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, errorCode: 'not_found' };
  }

  return fetchAlertsForUser({ supabase, userId: user.id });
}

export const getAlertsAction = authActionClient
  .metadata({ actionName: 'dashboard.get_alerts', section: 'dashboard' })
  .action(async ({ ctx }): Promise<DashboardReadonlyActionResult<DashboardAlert[]>> => {
    return fetchAlertsForUser({
      supabase: asTypedSupabaseClient(ctx.supabase),
      userId: ctx.user.id,
    });
  });

async function fetchPriorityCountsForUser({
  merchantAccountId,
  shopId,
  supabase,
}: {
  merchantAccountId: string;
  shopId?: string | null;
  supabase: SupabaseServerClient;
}): Promise<DashboardReadonlyActionResult<DashboardPriorityCounts>> {
  // Agrégation SQL non plafonnée (RPC 0082). Les compteurs 7j (a_appeler / en_livraison /
  // annulees_retours) partent des bornes calculées CÔTE TS (source de vérité, aucune logique
  // de date en SQL) : resolvePeriodRange('7j') = fenêtre alignée /commandes?period=7j.
  // « À rappeler » (Option A, issue #58) ne filtre plus sur une date : il compte TOUTES les
  // tentées open+callback (= liste tentee-a-rappeler) car next_contact_at n'est jamais
  // renseigné par le geste « À rappeler » → l'ancien filtre « aujourd'hui » restait à 0.
  const { from: sinceDate, to: untilDate } = resolvePeriodRange({
    allowedPresets: PERIOD_PRESETS,
    defaultPreset: '7j',
    period: '7j',
  });

  const { data, error } = await supabase.rpc('get_dashboard_priority_counts', {
    p_merchant_id: merchantAccountId,
    p_since: sinceDate.toISOString(),
    p_until: untilDate.toISOString(),
    ...(shopId ? { p_shop_id: shopId } : {}),
  });

  if (error) {
    return { ok: false, errorCode: 'query_error' };
  }

  const row = isRecord(data) ? data : {};

  return {
    ok: true,
    data: {
      aAppeler: numberField(row, 'a_appeler'),
      aRappeler: numberField(row, 'a_rappeler'),
      enLivraison: numberField(row, 'en_livraison'),
      annuleesRetours: numberField(row, 'annulees_retours'),
    },
  };
}

async function fetchDashboardCashCollectedTotalForUser({
  from,
  merchantAccountId,
  shopId,
  supabase,
  to,
}: {
  from: Date;
  merchantAccountId: string;
  shopId?: string | null;
  supabase: SupabaseServerClient;
  to: Date;
}): Promise<DashboardReadonlyActionResult<DashboardCashCollectedTotal>> {
  const { data, error } = await supabase.rpc('get_dashboard_cash_collected_total', {
    p_merchant_id: merchantAccountId,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
    ...(shopId ? { p_shop_id: shopId } : {}),
  });

  if (error) {
    return { ok: false, errorCode: 'query_error' };
  }

  const row = Array.isArray(data) ? data[0] : null;
  if (!row) {
    return { ok: true, data: { caMinor: 0 } };
  }

  return {
    ok: true,
    data: {
      caMinor: numberField(row, 'ca_encaisse_minor'),
    },
  };
}

async function fetchDashboardCashCollectedByProductForUser({
  from,
  merchantAccountId,
  shopId,
  to,
}: {
  from: Date;
  merchantAccountId: string;
  shopId?: string | null;
  to: Date;
}): Promise<DashboardReadonlyActionResult<DashboardCashCollectedByProduct>> {
  const admin = createFinanceAdminClient();
  const ordersPage = (offset: number) => {
    let query = admin
      .from('orders')
      .select('id, items_summary, total_amount')
      .eq('merchant_account_id', merchantAccountId)
      .gte('cash_collected_at', from.toISOString())
      .lte('cash_collected_at', to.toISOString())
      .order('id', { ascending: true });

    if (shopId) {
      query = query.eq('shop_id', shopId);
    }

    return query.range(offset, offset + 499);
  };

  const productsPage = (offset: number) =>
    admin
      .from('product')
      .select('id, title, unit_cost')
      .eq('merchant_account_id', merchantAccountId)
      .order('id', { ascending: true })
      .range(offset, offset + 499);

  const [ordersResult, productsResult, collectedJoins] = await Promise.all([
    fetchAllPages(ordersPage),
    fetchAllPages(productsPage),
    fetchFinanceCollectedJoins(
      admin,
      merchantAccountId,
      from.toISOString(),
      to.toISOString(),
      shopId,
    ),
  ]);

  if (ordersResult.error || productsResult.error) {
    return { ok: false, errorCode: 'query_error' };
  }

  return {
    ok: true,
    data: buildDashboardCashCollectedByProduct({
      orderLines: collectedJoins.orderLines.map((line) => ({
        orderId: line.order_id,
        productId: line.product_id,
        qty: line.qty,
        rawTitle: line.raw_title,
      })),
      orders: ordersResult.data.map((order) => ({
        id: order.id,
        itemsSummary: order.items_summary,
        totalAmount: order.total_amount,
      })),
      products: productsResult.data.map((product) => ({
        id: product.id,
        title: product.title,
        unitCost: product.unit_cost,
      })),
    }),
  };
}

async function fetchDashboardDeliveriesByProductForUser({
  from,
  merchantAccountId,
  shopId,
  supabase,
  to,
}: {
  from: Date;
  merchantAccountId: string;
  shopId?: string | null;
  supabase: SupabaseServerClient;
  to: Date;
}): Promise<DashboardReadonlyActionResult<DashboardDeliveriesByProduct>> {
  const { data, error } = await supabase.rpc('get_dashboard_deliveries_by_product', {
    p_merchant_id: merchantAccountId,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
    ...(shopId ? { p_shop_id: shopId } : {}),
  });

  if (error) {
    return { ok: false, errorCode: 'query_error' };
  }

  return toDashboardDeliveriesByProduct(data);
}

export async function getPriorityCounts(
  shopId?: string | null,
): Promise<DashboardReadonlyActionResult<DashboardPriorityCounts>> {
  const ctx = await getCachedDashboardContext();

  if (!ctx.ok) {
    return { ok: false, errorCode: 'not_found' };
  }

  return fetchPriorityCountsForUser({
    merchantAccountId: ctx.merchantAccountId,
    shopId,
    supabase: ctx.supabase,
  });
}

export async function getDashboardCashCollectedTotal({
  from,
  shopId,
  to,
}: {
  from: Date;
  shopId?: string | null;
  to: Date;
}): Promise<DashboardReadonlyActionResult<DashboardCashCollectedTotal>> {
  const ctx = await getCachedDashboardContext();

  if (!ctx.ok) {
    return { ok: false, errorCode: 'not_found' };
  }

  return fetchDashboardCashCollectedTotalForUser({
    from,
    merchantAccountId: ctx.merchantAccountId,
    shopId,
    supabase: ctx.supabase,
    to,
  });
}

export async function getDashboardCashCollectedByProduct({
  from,
  shopId,
  to,
}: {
  from: Date;
  shopId?: string | null;
  to: Date;
}): Promise<DashboardReadonlyActionResult<DashboardCashCollectedByProduct>> {
  const ctx = await getCachedDashboardContext();

  if (!ctx.ok) {
    return { ok: false, errorCode: 'not_found' };
  }

  if (ctx.role !== 'owner' && ctx.role !== 'manager') {
    return { ok: false, errorCode: 'not_found' };
  }

  return fetchDashboardCashCollectedByProductForUser({
    from,
    merchantAccountId: ctx.merchantAccountId,
    shopId,
    to,
  });
}

export async function getDashboardDeliveriesByProduct({
  from,
  shopId,
  to,
}: {
  from: Date;
  shopId?: string | null;
  to: Date;
}): Promise<DashboardReadonlyActionResult<DashboardDeliveriesByProduct>> {
  const ctx = await getCachedDashboardContext();

  if (!ctx.ok) {
    return { ok: false, errorCode: 'not_found' };
  }

  return fetchDashboardDeliveriesByProductForUser({
    from,
    merchantAccountId: ctx.merchantAccountId,
    shopId,
    supabase: ctx.supabase,
    to,
  });
}
