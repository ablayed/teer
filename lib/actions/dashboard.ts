'use server';

import { authActionClient } from '@/lib/actions/safe-action';
import { type OrderStatus, orderStatuses } from '@/lib/domain/order-state-machine';
import type { Database } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

type SupabaseServerClient = SupabaseClient<Database>;
type DashboardKpiRpcPayload = Record<string, unknown>;
const dashboardShopFilterSchema = z
  .object({
    shopId: z.string().uuid().nullable().optional(),
  })
  .optional();

export type DashboardSparklinePoint = {
  date: string;
  value: number;
};

export type DashboardKpi = {
  a_appeler_count: number;
  a_appeler_delta: number;
  ca_collecte_7j: number;
  ca_en_attente: number;
  currency: string | null;
  taux_confirmation: number;
  taux_livraison: number;
  sparkline_7j: DashboardSparklinePoint[];
};

export type DashboardKpiActionResult =
  | { ok: true; data: DashboardKpi }
  | { ok: false; errorCode: 'not_found' | 'rpc_error' };

export type DashboardRevenuePoint = {
  date: string;
  value: number;
};

export type DashboardRevenue30d = {
  currency: string | null;
  points: DashboardRevenuePoint[];
};

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

function parseJsonString(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return [];
  }
}

function parseSparkline(value: unknown): DashboardSparklinePoint[] {
  const parsedValue = typeof value === 'string' ? parseJsonString(value) : value;
  const rawItems = Array.isArray(parsedValue)
    ? parsedValue
    : isRecord(parsedValue)
      ? Object.values(parsedValue)
      : [];

  return rawItems
    .map((item) => {
      if (!isRecord(item)) {
        return null;
      }

      const date = item.date;
      const sparklineValue = numberFromRpc(item.value);

      if (typeof date !== 'string') {
        return null;
      }

      return {
        date,
        value: sparklineValue,
      };
    })
    .filter((item): item is DashboardSparklinePoint => item !== null);
}

function firstRpcRow(value: unknown): DashboardKpiRpcPayload | null {
  const row = Array.isArray(value) ? value[0] : value;

  return isRecord(row) ? row : null;
}

function normalizeCurrency(value: string | null | undefined): string | null {
  const currency = value?.trim().toUpperCase();

  return currency ? currency : null;
}

function toDashboardKpi(row: DashboardKpiRpcPayload, currency: string | null): DashboardKpi {
  return {
    a_appeler_count: numberFromRpc(row.a_appeler_count),
    a_appeler_delta: numberFromRpc(row.a_appeler_delta),
    ca_collecte_7j: numberFromRpc(row.ca_collecte_7j),
    ca_en_attente: numberFromRpc(row.ca_en_attente),
    currency,
    taux_confirmation: numberFromRpc(row.taux_confirmation),
    taux_livraison: numberFromRpc(row.taux_livraison),
    sparkline_7j: parseSparkline(row.sparkline_7j),
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

function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function createEmptyRevenueWindow(today = new Date()): DashboardRevenuePoint[] {
  return Array.from({ length: 30 }, (_, index) => {
    const date = new Date(today);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - (29 - index));

    return { date: dateKey(date), value: 0 };
  });
}

function dateFromOrder(value: string | null, fallback: string): Date {
  return new Date(value ?? fallback);
}

function aggregateRevenue30d(
  orders: Array<{
    created_at: string;
    created_at_shopify: string | null;
    currency: string | null;
    total_amount: number;
  }>,
): DashboardRevenue30d {
  const points = createEmptyRevenueWindow();
  const pointIndex = new Map(points.map((point, index) => [point.date, index]));
  const firstPointDate = new Date(`${points[0]?.date ?? dateKey(new Date())}T00:00:00.000Z`);
  let currency: string | null = null;

  for (const order of orders) {
    const orderDate = dateFromOrder(order.created_at_shopify, order.created_at);

    if (orderDate < firstPointDate) {
      continue;
    }

    const index = pointIndex.get(dateKey(orderDate));

    if (index === undefined) {
      continue;
    }

    points[index].value += Number(order.total_amount ?? 0);
    currency ??= normalizeCurrency(order.currency);
  }

  return { currency, points };
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

function parseItems(value: unknown): Array<{ price: number; quantity: number; title: string }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!isRecord(item)) {
        return null;
      }

      const title = stringField(item, 'title');

      if (!title) {
        return null;
      }

      return {
        title,
        quantity: numberField(item, 'quantity'),
        price: numberField(item, 'price'),
      };
    })
    .filter((item): item is { price: number; quantity: number; title: string } => item !== null);
}

async function fetchTopProductsForUser({
  shopId,
  supabase,
  userId,
}: {
  shopId?: string | null;
  supabase: SupabaseServerClient;
  userId: string;
}): Promise<DashboardReadonlyActionResult<DashboardTopProduct[]>> {
  const merchant = await getMerchantAccountIdForUser({ supabase, userId });

  if (!merchant.ok) {
    return { ok: false, errorCode: 'not_found' };
  }

  let query = supabase
    .from('orders')
    .select('items_summary')
    .eq('merchant_account_id', merchant.merchantAccountId)
    .in('cod_status', ['CONFIRMEE', 'PROGRAMMEE', 'EN_LIVRAISON', 'LIVREE'])
    .order('created_at', { ascending: false });

  if (shopId) {
    query = query.eq('shop_id', shopId);
  }

  const { data, error } = await query.limit(500);

  if (error) {
    return { ok: false, errorCode: 'query_error' };
  }

  const productMap = new Map<string, DashboardTopProduct>();

  for (const order of data ?? []) {
    for (const item of parseItems(order.items_summary)) {
      const current = productMap.get(item.title) ?? { name: item.title, revenue: 0, units: 0 };
      current.units += item.quantity;
      current.revenue += item.quantity * item.price;
      productMap.set(item.title, current);
    }
  }

  return {
    ok: true,
    data: [...productMap.values()]
      .sort((first, second) => second.units - first.units || second.revenue - first.revenue)
      .slice(0, 5),
  };
}

async function fetchShopPerformanceForUser({
  shopId,
  supabase,
  userId,
}: {
  shopId?: string | null;
  supabase: SupabaseServerClient;
  userId: string;
}): Promise<DashboardReadonlyActionResult<DashboardShopPerformance[]>> {
  const merchant = await getMerchantAccountIdForUser({ supabase, userId });

  if (!merchant.ok) {
    return { ok: false, errorCode: 'not_found' };
  }

  let shopsQuery = supabase
    .from('shop')
    .select('id, shop_domain, status')
    .eq('merchant_account_id', merchant.merchantAccountId)
    .order('installed_at', { ascending: true });
  let ordersQuery = supabase
    .from('orders')
    .select('shop_id, total_amount')
    .eq('merchant_account_id', merchant.merchantAccountId);

  if (shopId) {
    shopsQuery = shopsQuery.eq('id', shopId);
    ordersQuery = ordersQuery.eq('shop_id', shopId);
  }

  const [shopsResult, ordersResult] = await Promise.all([shopsQuery, ordersQuery]);

  if (shopsResult.error || ordersResult.error) {
    return { ok: false, errorCode: 'query_error' };
  }

  const orderStats = new Map<string, { ordersCount: number; revenue: number }>();

  for (const order of ordersResult.data ?? []) {
    if (!order.shop_id) {
      continue;
    }

    const current = orderStats.get(order.shop_id) ?? { ordersCount: 0, revenue: 0 };
    current.ordersCount += 1;
    current.revenue += Number(order.total_amount ?? 0);
    orderStats.set(order.shop_id, current);
  }

  return {
    ok: true,
    data: (shopsResult.data ?? []).map((shop) => ({
      id: shop.id,
      name: shop.shop_domain,
      status: shop.status,
      ordersCount: orderStats.get(shop.id)?.ordersCount ?? 0,
      revenue: orderStats.get(shop.id)?.revenue ?? 0,
    })),
  };
}

async function fetchCodBreakdownForUser({
  shopId,
  supabase,
  userId,
}: {
  shopId?: string | null;
  supabase: SupabaseServerClient;
  userId: string;
}): Promise<DashboardReadonlyActionResult<DashboardCodBreakdownItem[]>> {
  const merchant = await getMerchantAccountIdForUser({ supabase, userId });

  if (!merchant.ok) {
    return { ok: false, errorCode: 'not_found' };
  }

  let query = supabase
    .from('orders')
    .select('cod_status')
    .eq('merchant_account_id', merchant.merchantAccountId);

  if (shopId) {
    query = query.eq('shop_id', shopId);
  }

  const { data, error } = await query;

  if (error) {
    return { ok: false, errorCode: 'query_error' };
  }

  const counts = new Map<OrderStatus, number>(orderStatuses.map((status) => [status, 0]));

  for (const order of data ?? []) {
    if (isOrderStatus(order.cod_status)) {
      counts.set(order.cod_status, (counts.get(order.cod_status) ?? 0) + 1);
    }
  }

  return {
    ok: true,
    data: orderStatuses.map((status) => ({ status, count: counts.get(status) ?? 0 })),
  };
}

async function fetchRecentActivityForUser({
  shopId,
  supabase,
  userId,
}: {
  shopId?: string | null;
  supabase: SupabaseServerClient;
  userId: string;
}): Promise<DashboardReadonlyActionResult<DashboardRecentActivityItem[]>> {
  const merchant = await getMerchantAccountIdForUser({ supabase, userId });

  if (!merchant.ok) {
    return { ok: false, errorCode: 'not_found' };
  }

  const { data, error } = await supabase
    .from('order_state_transition')
    .select('id, created_at, from_status, to_status, order:order_id(order_number, shop_id)')
    .eq('merchant_account_id', merchant.merchantAccountId)
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

async function fetchRevenue30dForUser({
  shopId,
  supabase,
  userId,
}: {
  shopId?: string | null;
  supabase: SupabaseServerClient;
  userId: string;
}): Promise<DashboardRevenue30dActionResult> {
  const merchant = await getMerchantAccountIdForUser({ supabase, userId });

  if (!merchant.ok) {
    return { ok: false, errorCode: 'not_found' };
  }

  let query = supabase
    .from('orders')
    .select('created_at, created_at_shopify, currency, total_amount')
    .eq('merchant_account_id', merchant.merchantAccountId)
    .eq('cod_status', 'LIVREE')
    .order('created_at', { ascending: false });

  if (shopId) {
    query = query.eq('shop_id', shopId);
  }

  const { data, error } = await query.limit(5000);

  if (error) {
    return { ok: false, errorCode: 'query_error' };
  }

  return { ok: true, data: aggregateRevenue30d(data ?? []) };
}

async function fetchDashboardKpiForUser({
  shopId,
  supabase,
  userId,
}: {
  shopId?: string | null;
  supabase: SupabaseServerClient;
  userId: string;
}): Promise<DashboardKpiActionResult> {
  const { data: member, error: memberError } = await supabase
    .from('merchant_member')
    .select('merchant_account_id')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();

  if (memberError) {
    return { ok: false, errorCode: 'rpc_error' };
  }

  if (!member) {
    return { ok: false, errorCode: 'not_found' };
  }

  let currencyQuery = supabase
    .from('orders')
    .select('currency')
    .eq('merchant_account_id', member.merchant_account_id)
    .not('currency', 'is', null);

  if (shopId) {
    currencyQuery = currencyQuery.eq('shop_id', shopId);
  }

  const [kpiResult, currencyResult] = await Promise.all([
    supabase.rpc('get_dashboard_kpi', {
      p_merchant_id: member.merchant_account_id,
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

export async function getDashboardKpi(shopId?: string | null): Promise<DashboardKpiActionResult> {
  const supabase = asTypedSupabaseClient(await createSupabaseServerClient());
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, errorCode: 'not_found' };
  }

  return fetchDashboardKpiForUser({ shopId, supabase, userId: user.id });
}

export const getDashboardKpiAction = authActionClient
  .metadata({ actionName: 'dashboard.get_kpi', section: 'dashboard' })
  .inputSchema(dashboardShopFilterSchema)
  .action(async ({ ctx, parsedInput }): Promise<DashboardKpiActionResult> => {
    return fetchDashboardKpiForUser({
      shopId: parsedInput?.shopId ?? null,
      supabase: asTypedSupabaseClient(ctx.supabase),
      userId: ctx.user.id,
    });
  });

export async function getRevenue30d(
  shopId?: string | null,
): Promise<DashboardRevenue30dActionResult> {
  const supabase = asTypedSupabaseClient(await createSupabaseServerClient());
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, errorCode: 'not_found' };
  }

  return fetchRevenue30dForUser({ shopId, supabase, userId: user.id });
}

export const getRevenue30dAction = authActionClient
  .metadata({ actionName: 'dashboard.get_revenue_30d', section: 'dashboard' })
  .action(async ({ ctx }): Promise<DashboardRevenue30dActionResult> => {
    return fetchRevenue30dForUser({
      supabase: asTypedSupabaseClient(ctx.supabase),
      userId: ctx.user.id,
    });
  });

export async function getTopProducts(
  shopId?: string | null,
): Promise<DashboardReadonlyActionResult<DashboardTopProduct[]>> {
  const supabase = asTypedSupabaseClient(await createSupabaseServerClient());
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, errorCode: 'not_found' };
  }

  return fetchTopProductsForUser({ shopId, supabase, userId: user.id });
}

export const getTopProductsAction = authActionClient
  .metadata({ actionName: 'dashboard.get_top_products', section: 'dashboard' })
  .action(async ({ ctx }): Promise<DashboardReadonlyActionResult<DashboardTopProduct[]>> => {
    return fetchTopProductsForUser({
      supabase: asTypedSupabaseClient(ctx.supabase),
      userId: ctx.user.id,
    });
  });

export async function getShopPerformance(
  shopId?: string | null,
): Promise<DashboardReadonlyActionResult<DashboardShopPerformance[]>> {
  const supabase = asTypedSupabaseClient(await createSupabaseServerClient());
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, errorCode: 'not_found' };
  }

  return fetchShopPerformanceForUser({ shopId, supabase, userId: user.id });
}

export const getShopPerformanceAction = authActionClient
  .metadata({ actionName: 'dashboard.get_shop_performance', section: 'dashboard' })
  .action(async ({ ctx }): Promise<DashboardReadonlyActionResult<DashboardShopPerformance[]>> => {
    return fetchShopPerformanceForUser({
      supabase: asTypedSupabaseClient(ctx.supabase),
      userId: ctx.user.id,
    });
  });

export async function getCodBreakdown(
  shopId?: string | null,
): Promise<DashboardReadonlyActionResult<DashboardCodBreakdownItem[]>> {
  const supabase = asTypedSupabaseClient(await createSupabaseServerClient());
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, errorCode: 'not_found' };
  }

  return fetchCodBreakdownForUser({ shopId, supabase, userId: user.id });
}

export const getCodBreakdownAction = authActionClient
  .metadata({ actionName: 'dashboard.get_cod_breakdown', section: 'dashboard' })
  .action(async ({ ctx }): Promise<DashboardReadonlyActionResult<DashboardCodBreakdownItem[]>> => {
    return fetchCodBreakdownForUser({
      supabase: asTypedSupabaseClient(ctx.supabase),
      userId: ctx.user.id,
    });
  });

export async function getRecentActivity(
  shopId?: string | null,
): Promise<DashboardReadonlyActionResult<DashboardRecentActivityItem[]>> {
  const supabase = asTypedSupabaseClient(await createSupabaseServerClient());
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, errorCode: 'not_found' };
  }

  return fetchRecentActivityForUser({ shopId, supabase, userId: user.id });
}

export const getRecentActivityAction = authActionClient
  .metadata({ actionName: 'dashboard.get_recent_activity', section: 'dashboard' })
  .action(
    async ({ ctx }): Promise<DashboardReadonlyActionResult<DashboardRecentActivityItem[]>> => {
      return fetchRecentActivityForUser({
        supabase: asTypedSupabaseClient(ctx.supabase),
        userId: ctx.user.id,
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
