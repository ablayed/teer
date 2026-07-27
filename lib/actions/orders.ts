'use server';

import { requireRole } from '@/lib/actions/safe-action';
import { performTransitionForContext } from '@/lib/actions/transitions';
import { normalizeSenegalPhone } from '@/lib/address/phone-sn';
import {
  type OrderSavedViewId,
  mapOrderViewCountRows,
  matchesOrderSavedView,
  orderQueueDate,
  orderSavedViewIds,
  parseOrderSavedViewId,
} from '@/lib/domain/order-saved-views';
import { type OrderStatus, orderStatuses } from '@/lib/domain/order-state-machine';
import {
  type TransitionAction,
  getAllowedTransitionActionsForDimensions,
  getTransitionActionForTarget,
  paymentChannelsAtDelivery,
  resolveOrderDimensions,
} from '@/lib/domain/order-transition-actions';
import { env } from '@/lib/env';
import { cashCollectableMinor } from '@/lib/finance/cash';
import { formatOrderAddress } from '@/lib/format/order-address';
import {
  type CallOutcome,
  callOutcomes,
  logCallInputSchema,
} from '@/lib/orders/call-log-validation';
import { getOrderCartEditingMode } from '@/lib/orders/cart-editing';
import { positiveOrderTotalSchema } from '@/lib/orders/order-amount-validation';
import { filterOrdersBySearch, legacySearchLookbackIso } from '@/lib/orders/search';
import { type CodStatus, codStatuses } from '@/lib/orders/status';
import { resolveAndInsertOrderLines } from '@/lib/stock/order-line-resolution';
import type { Database, Json, Tables, TablesUpdate } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { type TeamRole, isTeamRole } from '@/lib/team/permissions';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

type CustomerSummary = Pick<Tables<'customer'>, 'full_name' | 'phone'>;
type CustomerDetail = Pick<Tables<'customer'>, 'full_name' | 'phone' | 'shipping_address'>;
export type DeliveryAddress = Tables<'delivery_address'>;
type ReliabilityTier = 'new' | 'reliable' | 'risk' | 'watch';

type ReduceOrderCartPostAssignmentArgs = {
  p_lines: Json;
  p_order_id: string;
};

function reduceOrderCartPostAssignmentRpc(client: { rpc: SupabaseClient<Database>['rpc'] }) {
  return client.rpc.bind(client) as unknown as (
    fn: 'reduce_order_cart_post_assignment',
    args: ReduceOrderCartPostAssignmentArgs,
  ) => Promise<{ data: null; error: { message: string } | null }>;
}

export type OrderListItem = Pick<
  Tables<'orders'>,
  | 'assigned_driver_id'
  | 'cod_status'
  | 'call_state'
  | 'created_at'
  | 'created_at_shopify'
  | 'currency'
  | 'cash_state'
  | 'customer_id'
  | 'delivery_state'
  | 'id'
  | 'items_summary'
  | 'next_contact_at'
  | 'order_state'
  | 'order_number'
  | 'sort_at'
  | 'scheduled_for'
  | 'shipping_address'
  | 'source'
  | 'total_amount'
  | 'next_action_at'
> & {
  allowedActions: TransitionAction[];
  customer: CustomerSummary | null;
};

export type OrderDetail = Tables<'orders'> & {
  allowedActions: TransitionAction[];
  customer: CustomerDetail | null;
  customer_delivery_address: DeliveryAddress | null;
  delivery_address: DeliveryAddress | null;
};

type GetOrdersInput = {
  codStatus?: CodStatus;
  shopId?: string | null;
};

type SupabaseServerClient = SupabaseClient<Database>;
const manualOrderSources = [
  'manual',
  'whatsapp',
  'instagram',
  'tiktok',
  'facebook',
  'appel',
] as const;
const ORDERS_PAGE_SIZE = 25;

type CurrentMember = {
  merchantAccountId: string;
  role: TeamRole;
};

export type OrderListCursor = {
  id: string;
  sort: string;
};

export type OrdersViewCounts = Record<OrderSavedViewId, number>;

export type OrdersPageData = {
  activeView: OrderSavedViewId;
  hasMore: boolean;
  nextCursor: OrderListCursor | null;
  orders: OrderListItem[];
  reliabilityTiers: Record<string, ReliabilityTier>;
  search: string;
  totalCount: number;
  viewCounts: OrdersViewCounts;
};

type OrdersPageFilters = {
  dateFrom?: string;
  dateTo?: string;
  shopId?: string | null;
};

export type OrderTransitionTimelineEvent = {
  id: string;
  type: 'transition';
  createdAt: string;
  actorUserId: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  note: string | null;
};

export type OrderCallTimelineEvent = {
  id: string;
  type: 'call';
  createdAt: string;
  actorUserId: string;
  outcome: CallOutcome;
  note: string | null;
  nextActionAt: string | null;
};

export type OrderTimelineEvent = OrderTransitionTimelineEvent | OrderCallTimelineEvent;

function createSupabaseAdminClient() {
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function asTypedSupabaseClient(client: unknown): SupabaseServerClient {
  return client as SupabaseServerClient;
}

function isOrderStatus(value: string): value is OrderStatus {
  return orderStatuses.includes(value as OrderStatus);
}

function isCallOutcome(value: string): value is CallOutcome {
  return callOutcomes.includes(value as CallOutcome);
}

function toOrderStatus(value: string | null): OrderStatus | null {
  return value && isOrderStatus(value) ? value : null;
}

async function getCurrentMemberRole(supabase: SupabaseServerClient): Promise<TeamRole | null> {
  const member = await getCurrentMember(supabase);
  return member?.role ?? null;
}

async function getCurrentMember(
  supabase: SupabaseServerClient,
  signal?: AbortSignal,
): Promise<CurrentMember | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  signal?.throwIfAborted();

  if (!user) {
    return null;
  }

  let memberQuery = supabase
    .from('merchant_member')
    .select('merchant_account_id, role')
    .eq('user_id', user.id)
    .limit(1);

  if (signal) {
    memberQuery = memberQuery.abortSignal(signal);
  }

  const { data: member, error } = await memberQuery.maybeSingle();
  signal?.throwIfAborted();

  if (error || !member || !isTeamRole(member.role)) {
    return null;
  }

  return {
    merchantAccountId: member.merchant_account_id,
    role: member.role,
  };
}

function allowedActionsForOrderRow(
  order: Pick<
    Tables<'orders'>,
    'call_state' | 'cash_state' | 'cod_status' | 'delivery_state' | 'order_state'
  >,
  role: TeamRole | null,
): TransitionAction[] {
  return role ? getAllowedTransitionActionsForDimensions(resolveOrderDimensions(order), role) : [];
}

function revalidateOrderPaths(orderId: string) {
  revalidatePath('/commandes');
  revalidatePath(`/commandes/${orderId}`);
}

function toCallOutcome(value: string): CallOutcome {
  return isCallOutcome(value) ? value : 'SANS_REPONSE';
}

function buildNextCursor(
  orders: OrderListItem[],
  activeView: OrderSavedViewId,
): OrderListCursor | null {
  const lastOrder = orders.at(-1);

  if (!lastOrder) {
    return null;
  }

  const sort = activeView === 'tentee-a-rappeler' ? lastOrder.next_action_at : lastOrder.sort_at;

  return sort ? { id: lastOrder.id, sort } : null;
}

function emptyOrdersViewCounts(): OrdersViewCounts {
  return {
    toutes: 0,
    'a-appeler': 0,
    'tentee-a-rappeler': 0,
    confirmee: 0,
    'en-livraison': 0,
    valide: 0,
    'annulees-retours': 0,
  };
}

// Vues dont la période se filtre sur la dernière transition métier (cf. Tableau
// « Priorités à traiter ») plutôt que sur une date de commande : le compteur dashboard
// et /commandes doivent partager exactement le même champ pour que compteur = liste.
const VIEW_TRANSITION_STATUSES: Partial<Record<OrderSavedViewId, readonly string[]>> = {
  'en-livraison': ['EN_LIVRAISON'],
  'annulees-retours': ['ANNULEE', 'REFUSEE'],
};

const TRANSITION_ID_SETS_PAGE_SIZE = 500;

// PostgREST plafonne silencieusement toute requête sans .range()/.limit() à
// max_rows=1000 (supabase/config.toml:8). Sans pagination, au-delà de 1000 transitions
// dans la fenêtre le Set order_id est tronqué → des commandes disparaissent des vues
// en-livraison/annulees-retours alors qu'elles restent comptées par le Tableau (RPC SQL
// non plafonnée) — violation de « compteur = univers exact du lien » (Lot perf 1, QW2).
// Boucle .range() par paquets de 500. Tri sur `id` (clé primaire, unique) — order_id
// N'EST PAS unique ici (une commande peut transiter plusieurs fois vers le même statut),
// donc un ordre total requiert la PK propre de la ligne, pas order_id (aucun .order() avant).
async function fetchTransitionOrderIds(
  supabase: SupabaseServerClient,
  merchantAccountId: string,
  toStatuses: readonly string[],
  dateFrom: string,
  dateTo: string,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const orderIds = new Set<string>();

  for (let offset = 0; ; offset += TRANSITION_ID_SETS_PAGE_SIZE) {
    let query = supabase
      .from('order_state_transition')
      .select('order_id')
      .eq('merchant_account_id', merchantAccountId)
      .in('to_status', toStatuses)
      .gte('created_at', dateFrom)
      .lte('created_at', dateTo)
      .order('id', { ascending: true })
      .range(offset, offset + TRANSITION_ID_SETS_PAGE_SIZE - 1);

    if (signal) {
      query = query.abortSignal(signal);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    const batch = data ?? [];
    for (const row of batch) {
      orderIds.add(row.order_id);
    }

    if (batch.length < TRANSITION_ID_SETS_PAGE_SIZE) {
      break;
    }
  }

  return orderIds;
}

async function fetchTransitionOrderIdSets(
  supabase: SupabaseServerClient,
  merchantAccountId: string,
  dateFrom: string | undefined,
  dateTo: string | undefined,
  signal?: AbortSignal,
): Promise<Partial<Record<OrderSavedViewId, Set<string>>>> {
  if (!dateFrom || !dateTo) {
    return {};
  }

  const entries = await Promise.all(
    (Object.entries(VIEW_TRANSITION_STATUSES) as Array<[OrderSavedViewId, readonly string[]]>).map(
      async ([viewId, toStatuses]) => {
        const orderIds = await fetchTransitionOrderIds(
          supabase,
          merchantAccountId,
          toStatuses,
          dateFrom,
          dateTo,
          signal,
        );

        return [viewId, orderIds] as const;
      },
    ),
  );

  return Object.fromEntries(entries);
}

function orderMatchesPeriod(
  order: Pick<OrderListItem, 'created_at' | 'created_at_shopify' | 'id'>,
  from: string | undefined,
  to: string | undefined,
  view: OrderSavedViewId,
  transitionOrderIds: Set<string> | null,
) {
  if (!from || !to) {
    return true;
  }

  // Ligne « En cours de livraison » / « Annulées / Retours » du Tableau : la période se
  // vérifie sur la dernière transition métier (order_state_transition), pas sur une date
  // de commande — garde ciblée à ces 2 vues, orderQueueDate reste inchangé partout ailleurs.
  if (transitionOrderIds) {
    return transitionOrderIds.has(order.id);
  }

  // Ligne « À appeler » du Tableau : alignée sur la carte KPI (RPC get_dashboard_kpi,
  // migration 0076) qui borne sur `created_at`, pas `orderQueueDate` — garde ciblée à cette
  // seule vue pour que compteur dashboard = liste /commandes?vue=a-appeler.
  const referenceDate = new Date(view === 'a-appeler' ? order.created_at : orderQueueDate(order));
  const fromDate = new Date(from);
  const toDate = new Date(to);

  if (
    Number.isNaN(referenceDate.getTime()) ||
    Number.isNaN(fromDate.getTime()) ||
    Number.isNaN(toDate.getTime())
  ) {
    return true;
  }

  return referenceDate >= fromDate && referenceDate <= toDate;
}

function paginateOrders(
  orders: OrderListItem[],
  activeView: OrderSavedViewId,
  cursor: OrderListCursor | null,
) {
  const sorted = [...orders].sort((left, right) => {
    if (activeView === 'tentee-a-rappeler') {
      const leftKey = left.next_action_at ?? '';
      const rightKey = right.next_action_at ?? '';
      const dateOrder = leftKey.localeCompare(rightKey);
      return dateOrder !== 0 ? dateOrder : left.id.localeCompare(right.id);
    }

    const leftKey = left.sort_at ?? orderQueueDate(left);
    const rightKey = right.sort_at ?? orderQueueDate(right);
    const dateOrder = rightKey.localeCompare(leftKey);
    return dateOrder !== 0 ? dateOrder : right.id.localeCompare(left.id);
  });

  const startIndex = cursor
    ? sorted.findIndex((order) => {
        const sort = activeView === 'tentee-a-rappeler' ? order.next_action_at : order.sort_at;
        return order.id === cursor.id && sort === cursor.sort;
      }) + 1
    : 0;

  const page = sorted.slice(Math.max(0, startIndex), Math.max(0, startIndex) + ORDERS_PAGE_SIZE);
  const hasMore = Math.max(0, startIndex) + ORDERS_PAGE_SIZE < sorted.length;

  return {
    hasMore,
    nextCursor: hasMore ? buildNextCursor(page, activeView) : null,
    orders: page,
  };
}

// Fix de triage (freeze /commandes à la recherche) : ce chemin (fetchOrdersPageDataLegacy,
// déclenché dès qu'une recherche texte est active) chargeait TOUT l'historique de commandes
// du marchand sans aucun filtre de date, en boucle .range(500) séquentielle, avant de faire
// ~9 passes JS de filtrage/tri dessus — sur un gros tenant, chaque frappe déclenchait un scan
// non borné proportionnel au volume all-time, pas à la période sélectionnée. Bornage TEMPORAIRE
// à 12 mois glissants sur `sort_at` (colonne générée = coalesce(created_at_shopify, created_at),
// migration 0044 — strictement équivalente à `orderQueueDate`, déjà indexée par Lot 7, aucun
// nouvel index nécessaire). Volontairement INDÉPENDANT de `filters.dateFrom`/`dateTo` (le filtre
// période de l'UI) : la recherche doit pouvoir retrouver une commande hors période affichée,
// juste pas au-delà de 12 mois. Solution définitive prévue : RPC de recherche SQL paginée
// (fusionnée avec la recherche par numéro de commande, lot séparé) — ne pas considérer ce
// bornage comme un comportement produit final. `legacySearchLookbackIso` vit dans
// `lib/orders/search.ts` (fichier pur, testé isolément) — cf. gotcha CLAUDE.md sur l'import
// de `lib/env.ts` qui rend ce fichier impossible à unit-tester directement.
async function listOrdersForPageData({
  filters,
  member,
  signal,
  supabase,
}: {
  filters: OrdersPageFilters;
  member: CurrentMember;
  signal?: AbortSignal;
  supabase: SupabaseServerClient;
}): Promise<OrderListItem[]> {
  const lookbackIso = legacySearchLookbackIso();

  const baseQuery = () => {
    let query = supabase
      .from('orders')
      .select(
        'id, customer_id, order_number, total_amount, currency, cod_status, order_state, call_state, delivery_state, cash_state, assigned_driver_id, items_summary, shipping_address, created_at, created_at_shopify, next_contact_at, scheduled_for, source, sort_at, next_action_at, customer:customer_id(full_name, phone)',
      )
      .eq('merchant_account_id', member.merchantAccountId)
      .gte('sort_at', lookbackIso)
      .order('sort_at', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false });

    if (filters.shopId) {
      query = query.eq('shop_id', filters.shopId);
    }

    return query;
  };

  const rows: Array<Omit<OrderListItem, 'allowedActions'>> = [];
  const batchSize = 500;

  for (let offset = 0; ; offset += batchSize) {
    let query = baseQuery().range(offset, offset + batchSize - 1);

    if (signal) {
      query = query.abortSignal(signal);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    const batch = (data ?? []) as Array<Omit<OrderListItem, 'allowedActions'>>;
    rows.push(...batch);

    if (batch.length < batchSize) {
      break;
    }
  }

  return rows.map((order) => ({
    ...order,
    allowedActions: allowedActionsForOrderRow(order, member.role),
  }));
}

function isReliabilityTier(value: string | null): value is ReliabilityTier {
  return value === 'new' || value === 'reliable' || value === 'risk' || value === 'watch';
}

async function getReliabilityTiersForOrders(
  supabase: SupabaseServerClient,
  merchantAccountId: string,
  customerIds: string[],
  signal?: AbortSignal,
): Promise<Record<string, ReliabilityTier>> {
  const uniqueCustomerIds = [...new Set(customerIds)];

  if (uniqueCustomerIds.length === 0) {
    return {};
  }

  const entries = await Promise.all(
    uniqueCustomerIds.map(async (customerId) => {
      let query = supabase.rpc('get_customer_reliability', {
        p_customer_id: customerId,
        p_merchant_id: merchantAccountId,
      });

      if (signal) {
        query = query.abortSignal(signal);
      }

      const { data, error } = await query;

      if (error) {
        throw error;
      }

      const tier = data?.[0]?.tier ?? null;
      return isReliabilityTier(tier) ? ([customerId, tier] as const) : null;
    }),
  );

  return Object.fromEntries(
    entries.filter((entry): entry is readonly [string, ReliabilityTier] => entry !== null),
  );
}

// Lot 6 (migration 0088) — compteurs de vues en SQL, UNIQUEMENT quand aucune recherche texte
// n'est active (search === '', cas ultra-majoritaire : la frappe interactive est shallow côté
// client sans round-trip serveur, cf. orders-page-loader.tsx). Reproduit exactement les 7
// prédicats de matchesOrderSavedView/orderMatchesPeriod côté SQL — ne remplace PAS le calcul
// TS (conservé tel quel comme fallback quand une recherche est active, cf.
// fetchOrdersPageData).
async function fetchOrderViewCountsFromRpc(
  supabase: SupabaseServerClient,
  merchantAccountId: string,
  filters: { dateFrom: string; dateTo: string; shopId?: string | null },
  signal?: AbortSignal,
): Promise<OrdersViewCounts> {
  let query = supabase.rpc('get_order_view_counts', {
    p_from: filters.dateFrom,
    p_merchant_id: merchantAccountId,
    p_shop_id: filters.shopId ?? undefined,
    p_to: filters.dateTo,
  });

  if (signal) {
    query = query.abortSignal(signal);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return mapOrderViewCountRows(data ?? []);
}

type OrderKeysetRow = Database['public']['Functions']['list_orders_keyset']['Returns'][number];

// Lot 7 (migration 0089) — page 1+ de la liste via keyset SQL, UNIQUEMENT quand aucune
// recherche texte n'est active (même garde que Lot 6/get_order_view_counts). Récupère
// ORDERS_PAGE_SIZE + 1 lignes pour déduire hasMore/nextCursor côté TS, sans colonne dédiée côté
// RPC (contrat RPC simple et symétrique avec la pagination actuelle). Aplatit customer_full_name/
// customer_phone en `customer: {full_name, phone} | null`, shape OrderListItem inchangée.
async function fetchOrdersKeysetPage({
  activeView,
  cursor,
  filters,
  member,
  signal,
  supabase,
}: {
  activeView: OrderSavedViewId;
  cursor: OrderListCursor | null;
  filters: { dateFrom: string; dateTo: string; shopId?: string | null };
  member: CurrentMember;
  signal?: AbortSignal;
  supabase: SupabaseServerClient;
}): Promise<{ hasMore: boolean; nextCursor: OrderListCursor | null; orders: OrderListItem[] }> {
  let query = supabase.rpc('list_orders_keyset', {
    p_cursor_id: cursor?.id,
    p_cursor_sort: cursor?.sort,
    p_from: filters.dateFrom,
    p_limit: ORDERS_PAGE_SIZE + 1,
    p_merchant_id: member.merchantAccountId,
    p_shop_id: filters.shopId ?? undefined,
    p_to: filters.dateTo,
    p_view: activeView,
  });

  if (signal) {
    query = query.abortSignal(signal);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  const rows = (data ?? []) as OrderKeysetRow[];
  const hasMore = rows.length > ORDERS_PAGE_SIZE;
  const page = hasMore ? rows.slice(0, ORDERS_PAGE_SIZE) : rows;

  const orders: OrderListItem[] = page.map((row) => {
    const { customer_full_name, customer_phone, ...columns } = row;
    const order = columns as unknown as Omit<OrderListItem, 'allowedActions' | 'customer'>;

    return {
      ...order,
      allowedActions: allowedActionsForOrderRow(order, member.role),
      customer: order.customer_id ? { full_name: customer_full_name, phone: customer_phone } : null,
    };
  });

  const lastRow = page.at(-1);
  const cursorSort =
    activeView === 'tentee-a-rappeler' ? lastRow?.next_action_at : lastRow?.sort_at;
  const nextCursor = hasMore && lastRow && cursorSort ? { id: lastRow.id, sort: cursorSort } : null;

  return { hasMore, nextCursor, orders };
}

async function fetchOrdersPageData({
  activeView,
  cursor,
  filters,
  member,
  search,
  signal,
  supabase,
}: {
  activeView: OrderSavedViewId;
  cursor: OrderListCursor | null;
  filters: OrdersPageFilters;
  member: CurrentMember;
  search: string;
  signal?: AbortSignal;
  supabase: SupabaseServerClient;
}): Promise<OrdersPageData> {
  if (!search && filters.dateFrom && filters.dateTo) {
    const dateFrom = filters.dateFrom;
    const dateTo = filters.dateTo;

    const [viewCounts, keysetPage] = await Promise.all([
      cursor
        ? Promise.resolve(emptyOrdersViewCounts())
        : fetchOrderViewCountsFromRpc(
            supabase,
            member.merchantAccountId,
            {
              dateFrom,
              dateTo,
              shopId: filters.shopId,
            },
            signal,
          ),
      fetchOrdersKeysetPage({
        activeView,
        cursor,
        filters: { dateFrom, dateTo, shopId: filters.shopId },
        member,
        signal,
        supabase,
      }),
    ]);

    const reliabilityTiers =
      activeView === 'a-appeler'
        ? await getReliabilityTiersForOrders(
            supabase,
            member.merchantAccountId,
            keysetPage.orders
              .map((order) => order.customer_id)
              .filter((customerId): customerId is string => Boolean(customerId)),
            signal,
          )
        : {};

    return {
      activeView,
      hasMore: keysetPage.hasMore,
      nextCursor: keysetPage.nextCursor,
      orders: keysetPage.orders,
      reliabilityTiers,
      search,
      totalCount: cursor ? 0 : viewCounts.toutes,
      viewCounts,
    };
  }

  return fetchOrdersPageDataLegacy({
    activeView,
    cursor,
    filters,
    member,
    search,
    signal,
    supabase,
  });
}

// Chemin TS legacy — INCHANGÉ, utilisé quand une recherche texte est active (matching flou
// nom/produit/téléphone non porté en SQL, hors scope Lot 7) ou si les dates de période sont
// absentes (défensif, non atteint par /commandes en pratique).
async function fetchOrdersPageDataLegacy({
  activeView,
  cursor,
  filters,
  member,
  search,
  signal,
  supabase,
}: {
  activeView: OrderSavedViewId;
  cursor: OrderListCursor | null;
  filters: OrdersPageFilters;
  member: CurrentMember;
  search: string;
  signal?: AbortSignal;
  supabase: SupabaseServerClient;
}): Promise<OrdersPageData> {
  const scopedOrders = await listOrdersForPageData({ filters, member, signal, supabase });
  const transitionOrderIdsByView = await fetchTransitionOrderIdSets(
    supabase,
    member.merchantAccountId,
    filters.dateFrom,
    filters.dateTo,
    signal,
  );

  const periodFilteredFor = (viewId: OrderSavedViewId) =>
    scopedOrders.filter((order) =>
      orderMatchesPeriod(
        order,
        filters.dateFrom,
        filters.dateTo,
        viewId,
        transitionOrderIdsByView[viewId] ?? null,
      ),
    );

  let viewCounts: OrdersViewCounts;
  let totalCount: number;

  if (cursor) {
    // Pagination (page 2+) : les compteurs ne sont affichés qu'au premier chargement,
    // comportement inchangé (ni RPC ni calcul TS ici, comme avant ce lot).
    viewCounts = emptyOrdersViewCounts();
    totalCount = 0;
  } else if (search || !filters.dateFrom || !filters.dateTo) {
    // Recherche active OU période absente (défensif, non atteint par /commandes en pratique) :
    // calcul TS exact inchangé, sur scopedOrders déjà chargé pour la liste — zéro fetch de plus.
    viewCounts = orderSavedViewIds.reduce<OrdersViewCounts>((acc, viewId) => {
      const searchFiltered = filterOrdersBySearch(periodFilteredFor(viewId), search);
      acc[viewId] = searchFiltered.filter((order) => matchesOrderSavedView(order, viewId)).length;
      return acc;
    }, emptyOrdersViewCounts());
    totalCount = periodFilteredFor('toutes').length;
  } else {
    // search === '' : compteurs via get_order_view_counts (Lot 6, migration 0088). totalCount
    // ignore déjà la recherche dans l'ancien calcul TS (periodFilteredToutes n'était jamais
    // search-filtré) → la ligne 'toutes' de la RPC est strictement équivalente ici.
    viewCounts = await fetchOrderViewCountsFromRpc(
      supabase,
      member.merchantAccountId,
      {
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        shopId: filters.shopId,
      },
      signal,
    );
    totalCount = viewCounts.toutes;
  }

  const ordersForView = filterOrdersBySearch(periodFilteredFor(activeView), search).filter(
    (order) => matchesOrderSavedView(order, activeView),
  );
  const paginated = paginateOrders(ordersForView, activeView, cursor);
  const reliabilityTiers =
    activeView === 'a-appeler'
      ? await getReliabilityTiersForOrders(
          supabase,
          member.merchantAccountId,
          paginated.orders
            .map((order) => order.customer_id)
            .filter((customerId): customerId is string => Boolean(customerId)),
          signal,
        )
      : {};

  return {
    activeView,
    hasMore: paginated.hasMore,
    nextCursor: paginated.nextCursor,
    orders: paginated.orders,
    reliabilityTiers,
    search,
    totalCount,
    viewCounts,
  };
}

async function writeOrderAuditLog({
  action,
  actorUserId,
  merchantAccountId,
  orderId,
  payload,
}: {
  action: 'call.logged' | 'order.transition' | 'order.amounts_updated' | 'order.driver_reassigned';
  actorUserId: string;
  merchantAccountId: string;
  orderId: string;
  payload?: Database['public']['Tables']['audit_log']['Insert']['payload'];
}) {
  const admin = createSupabaseAdminClient();

  const { error } = await admin.from('audit_log').insert({
    merchant_account_id: merchantAccountId,
    actor_user_id: actorUserId,
    action,
    resource_type: 'orders',
    resource_id: orderId,
    payload,
  });

  return error;
}

async function getMerchantAccountIdForActor(
  supabase: SupabaseServerClient,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('merchant_member')
    .select('merchant_account_id')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return data.merchant_account_id;
}

async function findOrCreateCustomerByPhone({
  fullName,
  merchantAccountId,
  phone,
  shippingAddress,
  supabase,
}: {
  fullName?: string;
  merchantAccountId: string;
  phone: string;
  shippingAddress: Json | null;
  supabase: SupabaseServerClient;
}): Promise<
  { ok: true; customerId: string; normalizedPhone: string } | { message: string; ok: false }
> {
  const normalizedPhone = normalizeSenegalPhone(phone);

  if (!normalizedPhone) {
    return {
      ok: false,
      message: 'Numéro de téléphone sénégalais invalide.',
    };
  }

  const { data: matches, error: selectError } = await supabase
    .from('customer')
    .select('id, full_name, shipping_address, created_at')
    .eq('merchant_account_id', merchantAccountId)
    .eq('phone', normalizedPhone)
    .order('created_at', { ascending: true })
    .limit(2);

  if (selectError) {
    return { ok: false, message: 'Impossible de verifier le client existant.' };
  }

  const existingCustomer = matches?.[0] ?? null;

  if (existingCustomer) {
    const customerPatch: TablesUpdate<'customer'> = {
      ...(existingCustomer.full_name ? {} : fullName ? { full_name: fullName } : {}),
      ...(existingCustomer.shipping_address
        ? {}
        : shippingAddress
          ? { shipping_address: shippingAddress }
          : {}),
    };

    if (Object.keys(customerPatch).length > 0) {
      const { error: updateError } = await supabase
        .from('customer')
        .update(customerPatch)
        .eq('id', existingCustomer.id);

      if (updateError) {
        return { ok: false, message: 'Impossible de mettre a jour le client existant.' };
      }
    }

    return {
      ok: true,
      customerId: existingCustomer.id,
      normalizedPhone,
    };
  }

  const { data: insertedCustomer, error: insertError } = await supabase
    .from('customer')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: fullName ?? null,
      phone: normalizedPhone,
      shipping_address: shippingAddress,
    })
    .select('id')
    .single();

  if (insertError || !insertedCustomer) {
    return { ok: false, message: 'Impossible de creer le client.' };
  }

  return {
    ok: true,
    customerId: insertedCustomer.id,
    normalizedPhone,
  };
}

export async function getOrders({
  codStatus,
  shopId,
}: GetOrdersInput = {}): Promise<OrderListItem[]> {
  const supabase = asTypedSupabaseClient(await createSupabaseServerClient());
  const role = await getCurrentMemberRole(supabase);
  let query = supabase
    .from('orders')
    .select(
      'id, customer_id, order_number, total_amount, currency, cod_status, order_state, call_state, delivery_state, cash_state, items_summary, shipping_address, created_at, created_at_shopify, next_contact_at, scheduled_for, source, sort_at, next_action_at, customer:customer_id(full_name, phone)',
    )
    .order('created_at_shopify', { ascending: false, nullsFirst: false });

  if (codStatus) {
    query = query.eq('cod_status', codStatus);
  }

  if (shopId) {
    query = query.eq('shop_id', shopId);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return ((data ?? []) as Array<Omit<OrderListItem, 'allowedActions'>>).map((order) => ({
    ...order,
    allowedActions: allowedActionsForOrderRow(order, role),
  }));
}

export async function getOrdersPageData(
  {
    cursor = null,
    dateFrom,
    dateTo,
    search = '',
    shopId = null,
    view,
  }: {
    cursor?: OrderListCursor | null;
    dateFrom?: string;
    dateTo?: string;
    search?: string;
    shopId?: string | null;
    view?: string;
  } = {},
  signal?: AbortSignal,
): Promise<OrdersPageData> {
  const supabase = asTypedSupabaseClient(await createSupabaseServerClient());
  const member = await getCurrentMember(supabase, signal);

  if (!member) {
    return {
      activeView: parseOrderSavedViewId(view),
      hasMore: false,
      nextCursor: null,
      orders: [],
      reliabilityTiers: {},
      search,
      totalCount: 0,
      viewCounts: emptyOrdersViewCounts(),
    };
  }

  return fetchOrdersPageData({
    activeView: parseOrderSavedViewId(view),
    cursor,
    filters: { dateFrom, dateTo, shopId },
    member,
    search,
    signal,
    supabase,
  });
}

export const loadMoreOrdersAction = requireRole('owner', 'manager', 'agent')
  .metadata({ actionName: 'orders.load_more', section: 'orders' })
  .inputSchema(
    z.object({
      cursor: z
        .object({
          id: z.string().uuid(),
          sort: z.string().trim().min(1),
        })
        .nullable(),
      dateFrom: z.string().datetime().optional(),
      dateTo: z.string().datetime().optional(),
      search: z.string().default(''),
      shopId: z.string().uuid().nullable().optional(),
      view: z.enum(orderSavedViewIds).default('toutes'),
    }),
  )
  .action(async ({ ctx, parsedInput }) => {
    const data = await fetchOrdersPageData({
      activeView: parsedInput.view,
      cursor: parsedInput.cursor,
      filters: {
        dateFrom: parsedInput.dateFrom,
        dateTo: parsedInput.dateTo,
        shopId: parsedInput.shopId ?? null,
      },
      member: {
        merchantAccountId: ctx.member.merchantAccountId,
        role: ctx.member.role,
      },
      search: parsedInput.search,
      supabase: asTypedSupabaseClient(ctx.supabase),
    });

    return {
      ok: true as const,
      hasMore: data.hasMore,
      nextCursor: data.nextCursor,
      orders: data.orders,
      reliabilityTiers: data.reliabilityTiers,
    };
  });

export async function getOrderById(id: string): Promise<OrderDetail | null> {
  const supabase = asTypedSupabaseClient(await createSupabaseServerClient());
  const role = await getCurrentMemberRole(supabase);
  const { data, error } = await supabase
    .from('orders')
    .select('*, customer:customer_id(full_name, phone, shipping_address)')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  const [orderAddressResult, customerAddressResult] = await Promise.all([
    supabase
      .from('delivery_address')
      .select('*')
      .eq('merchant_account_id', data.merchant_account_id)
      .eq('order_id', data.id)
      .maybeSingle(),
    data.customer_id
      ? supabase
          .from('delivery_address')
          .select('*')
          .eq('merchant_account_id', data.merchant_account_id)
          .eq('customer_id', data.customer_id)
          .is('order_id', null)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (orderAddressResult.error) {
    throw orderAddressResult.error;
  }

  if (customerAddressResult.error) {
    throw customerAddressResult.error;
  }

  return {
    ...(data as Tables<'orders'> & { customer: CustomerDetail | null }),
    allowedActions: allowedActionsForOrderRow(data, role),
    delivery_address: orderAddressResult.data,
    customer_delivery_address: customerAddressResult.data,
  };
}

export async function getOrderTimeline(orderId: string): Promise<OrderTimelineEvent[]> {
  const supabase = asTypedSupabaseClient(await createSupabaseServerClient());

  const [transitionResult, callResult] = await Promise.all([
    supabase
      .from('order_state_transition')
      .select('id, actor_user_id, created_at, from_status, note, to_status')
      .eq('order_id', orderId)
      .order('created_at', { ascending: false }),
    supabase
      .from('call_log')
      .select('id, agent_user_id, created_at, next_action_at, note_fr, outcome')
      .eq('order_id', orderId)
      .order('created_at', { ascending: false }),
  ]);

  if (transitionResult.error) {
    throw transitionResult.error;
  }

  if (callResult.error) {
    throw callResult.error;
  }

  const transitions: OrderTransitionTimelineEvent[] = (transitionResult.data ?? [])
    .map((transition) => {
      const toStatus = toOrderStatus(transition.to_status);

      if (!toStatus) {
        return null;
      }

      return {
        id: transition.id,
        type: 'transition' as const,
        createdAt: transition.created_at,
        actorUserId: transition.actor_user_id,
        fromStatus: toOrderStatus(transition.from_status),
        toStatus,
        note: transition.note,
      };
    })
    .filter((event): event is OrderTransitionTimelineEvent => event !== null);

  const calls: OrderCallTimelineEvent[] = (callResult.data ?? []).map((call) => ({
    id: call.id,
    type: 'call',
    createdAt: call.created_at,
    actorUserId: call.agent_user_id,
    outcome: toCallOutcome(call.outcome),
    note: call.note_fr,
    nextActionAt: call.next_action_at,
  }));

  return [...transitions, ...calls].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const createManualOrderAction = requireRole('owner', 'manager', 'agent')
  .metadata({ actionName: 'orders.create_manual', section: 'orders' })
  .inputSchema(
    z.object({
      customerName: z.string().trim().min(2).max(120),
      phone: z.string().trim().min(1).max(40),
      source: z.enum(manualOrderSources).default('manual'),
      shopId: z.string().uuid().optional(),
      lines: z
        .array(
          z.object({
            productId: z.string().uuid(),
            quantity: z.number().int().min(1).max(999),
            unitPrice: z.number().min(0),
          }),
        )
        .min(1)
        .max(20),
      address: z.string().trim().max(500).optional(),
    }),
  )
  .action(async ({ ctx, parsedInput }) => {
    const supabase = asTypedSupabaseClient(ctx.supabase);
    const merchantAccountId = await getMerchantAccountIdForActor(supabase, ctx.user.id);

    if (!merchantAccountId) {
      return {
        ok: false as const,
        errorCode: 'merchant_not_found' as const,
        message: "Aucun compte marchand n'a ete trouve.",
      };
    }

    // Multi-boutiques (Phase 13) : on rattache la commande à une boutique.
    // 0 boutique → null (marchand manuel sans Shopify, comportement historique).
    // 1 boutique → rattachement automatique. >1 boutique → la boutique est
    // obligatoire (le formulaire l'impose aussi côté client).
    const { data: tenantShops } = await supabase
      .from('shop')
      .select('id')
      .eq('merchant_account_id', merchantAccountId);
    const shopIds = (tenantShops ?? []).map((shop) => shop.id);

    let resolvedShopId: string | null = null;
    if (parsedInput.shopId) {
      if (!shopIds.includes(parsedInput.shopId)) {
        return {
          ok: false as const,
          errorCode: 'update_failed' as const,
          message: 'Boutique introuvable.',
        };
      }
      resolvedShopId = parsedInput.shopId;
    } else if (shopIds.length === 1) {
      resolvedShopId = shopIds[0];
    } else if (shopIds.length > 1) {
      return {
        ok: false as const,
        errorCode: 'shop_required' as const,
        message: 'Veuillez sélectionner une boutique.',
      };
    }

    const shippingAddress = parsedInput.address
      ? ({
          address1: parsedInput.address,
        } satisfies Json)
      : null;

    const productIds = parsedInput.lines.map((l) => l.productId);
    const { data: products, error: productError } = await supabase
      .from('product')
      .select('id, title, sku')
      .eq('merchant_account_id', merchantAccountId)
      .in('id', productIds);

    if (productError || !products || products.length !== productIds.length) {
      return {
        ok: false as const,
        errorCode: 'update_failed' as const,
        message: 'Un ou plusieurs produits sont introuvables.',
      };
    }

    const productMap = new Map(products.map((p) => [p.id, p]));

    const customer = await findOrCreateCustomerByPhone({
      merchantAccountId,
      phone: parsedInput.phone,
      fullName: parsedInput.customerName,
      shippingAddress,
      supabase,
    });

    if (!customer.ok) {
      return {
        ok: false as const,
        errorCode: 'update_failed' as const,
        message: customer.message,
      };
    }

    const itemsSummary = parsedInput.lines.map((line) => {
      const product = productMap.get(line.productId);
      return {
        product_id: line.productId,
        title: product?.title ?? '',
        sku: product?.sku ?? null,
        quantity: line.quantity,
        price: line.unitPrice,
      };
    });
    const totalAmount = parsedInput.lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);

    // Migration 0101 : réservation atomique et strictement scopée au marchand.
    const { data: orderNumber, error: reservationError } = await supabase.rpc(
      'reserve_manual_order_number',
      { p_merchant_account_id: merchantAccountId },
    );

    if (reservationError || !orderNumber) {
      return {
        ok: false as const,
        errorCode: 'update_failed' as const,
        message: "Le numéro de la commande manuelle n'a pas pu être réservé.",
      };
    }

    const { data: order, error: insertError } = await supabase
      .from('orders')
      .insert({
        merchant_account_id: merchantAccountId,
        customer_id: customer.customerId,
        shop_id: resolvedShopId,
        shopify_order_id: null,
        source: parsedInput.source,
        order_number: orderNumber,
        total_amount: totalAmount,
        currency: 'XOF',
        items_summary: itemsSummary,
        shipping_address: shippingAddress,
        order_state: 'open',
        call_state: 'to_call',
        delivery_state: 'unassigned',
        cash_state: 'not_due',
      })
      .select('id')
      .single();

    if (insertError || !order) {
      return {
        ok: false as const,
        errorCode: 'update_failed' as const,
        message: "La commande manuelle n'a pas pu être créée.",
      };
    }

    // Best-effort: resolution failure never blocks order creation.
    await resolveAndInsertOrderLines(supabase, {
      merchantAccountId,
      orderId: order.id,
      lineItems: itemsSummary,
    }).catch(() => undefined);

    revalidatePath('/commandes');
    revalidatePath('/tableau');

    return {
      ok: true as const,
      orderId: order.id,
    };
  });

export const transitionOrderStatusAction = requireRole('owner', 'manager', 'agent')
  .metadata({ actionName: 'orders.transition_status', section: 'orders' })
  .inputSchema(
    z.object({
      orderId: z.string().uuid(),
      to: z.enum(orderStatuses),
      note: z.string().trim().max(500).optional(),
      paymentChannelAtDelivery: z.enum(paymentChannelsAtDelivery).optional(),
    }),
  )
  .action(async ({ ctx, parsedInput }) => {
    const action = getTransitionActionForTarget(parsedInput.to, ctx.member.role);

    if (!action) {
      return {
        ok: false as const,
        errorCode: 'forbidden' as const,
        message: "Vous n'avez pas le droit d'executer cette action.",
      };
    }

    const transition = await performTransitionForContext({
      action,
      actorUserId: ctx.user.id,
      orderId: parsedInput.orderId,
      payload: {
        note: parsedInput.note,
        paymentChannelAtDelivery: parsedInput.paymentChannelAtDelivery,
      },
      role: ctx.member.role,
      supabase: asTypedSupabaseClient(ctx.supabase),
    });

    if (!transition.ok) {
      return transition;
    }

    return {
      ok: true as const,
      newStatus: transition.order.cod_status,
      order: transition.order,
      allowedActions: transition.allowedActions,
    };
  });

function getAutoTransitionTarget(outcome: CallOutcome): OrderStatus {
  if (outcome === 'SANS_REPONSE' || outcome === 'A_RAPPELER') {
    return 'TENTEE';
  }

  return outcome;
}

export const logCallAction = requireRole('owner', 'manager', 'agent')
  .metadata({ actionName: 'orders.log_call', section: 'orders' })
  .inputSchema(logCallInputSchema)
  .action(async ({ ctx, parsedInput }) => {
    const supabase = asTypedSupabaseClient(ctx.supabase);
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select(
        'id, merchant_account_id, cod_status, order_state, call_state, delivery_state, cash_state',
      )
      .eq('id', parsedInput.orderId)
      .maybeSingle();

    if (orderError) {
      return { ok: false as const, errorCode: 'call_log_failed' as const };
    }

    if (!order) {
      return { ok: false as const, errorCode: 'order_not_found' as const };
    }

    const nextActionAt =
      parsedInput.outcome === 'A_RAPPELER' ? (parsedInput.nextActionAt ?? null) : null;

    const { error: callError } = await supabase.from('call_log').insert({
      merchant_account_id: order.merchant_account_id,
      order_id: order.id,
      agent_user_id: ctx.user.id,
      outcome: parsedInput.outcome,
      note_fr: parsedInput.note?.trim() || null,
      next_action_at: nextActionAt,
    });

    if (callError) {
      return { ok: false as const, errorCode: 'call_log_failed' as const };
    }

    const autoTransitionTarget = getAutoTransitionTarget(parsedInput.outcome);
    let transitioned = false;
    let transitionErrorCode:
      | 'forbidden'
      | 'audit_failed'
      | 'illegal_transition'
      | 'invalid_current_status'
      | 'missing_driver_for_dispatch'
      | 'order_not_found'
      | 'update_failed'
      | null = null;

    if (isOrderStatus(order.cod_status)) {
      const transitionAction = getTransitionActionForTarget(autoTransitionTarget, ctx.member.role);

      if (transitionAction) {
        const transition = await performTransitionForContext({
          action: transitionAction,
          actorUserId: ctx.user.id,
          orderId: order.id,
          payload: {
            nextContactAt: nextActionAt ?? undefined,
            note: parsedInput.note,
          },
          role: ctx.member.role,
          supabase,
        });

        transitioned = transition.ok;
        transitionErrorCode =
          transition.ok || transition.errorCode === 'audit_failed' ? null : transition.errorCode;
      } else {
        transitionErrorCode = 'forbidden';
      }
    } else {
      transitionErrorCode = 'invalid_current_status';
    }

    const auditError = await writeOrderAuditLog({
      action: 'call.logged',
      actorUserId: ctx.user.id,
      merchantAccountId: order.merchant_account_id,
      orderId: order.id,
      payload: {
        outcome: parsedInput.outcome,
        note: parsedInput.note ?? null,
        nextActionAt,
        transitioned,
        newStatus: transitioned ? autoTransitionTarget : null,
        transitionErrorCode,
      },
    });

    if (auditError) {
      return {
        ok: false as const,
        callLogged: true as const,
        transitioned,
        errorCode: 'audit_failed' as const,
      };
    }

    revalidateOrderPaths(order.id);

    return {
      ok: true as const,
      callLogged: true as const,
      transitioned,
      ...(transitioned ? { newStatus: autoTransitionTarget } : {}),
    };
  });

export const updateCodStatusAction = requireRole('owner', 'manager', 'agent')
  .metadata({ actionName: 'orders.update_cod_status', section: 'orders' })
  .inputSchema(
    z.object({
      orderId: z.string().uuid(),
      codStatus: z.enum(codStatuses),
    }),
  )
  .action(async ({ ctx, parsedInput }) => {
    const action = getTransitionActionForTarget(parsedInput.codStatus, ctx.member.role);

    if (!action) {
      return { ok: false as const, errorCode: 'forbidden' as const };
    }

    const transition = await performTransitionForContext({
      action,
      actorUserId: ctx.user.id,
      orderId: parsedInput.orderId,
      role: ctx.member.role,
      supabase: asTypedSupabaseClient(ctx.supabase),
    });

    if (!transition.ok) {
      return { ok: false as const, errorCode: transition.errorCode };
    }

    return { ok: true as const };
  });

// Phase 11 — édition des montants (total + frais de livraison) + ajustement de la
// date/heure de livraison. CE N'EST PAS une transition d'état : aucune des 4
// dimensions n'est touchée. Owner/manager uniquement (l'agent ne voit/édite pas
// les montants). RLS orders_update (WITH CHECK owner/manager) couvre l'écriture.
//
// cash_collectable_minor : rejoue la logique canal de transition_order via
// l'UNIQUE source canonique cashCollectableMinor() (lib/finance/cash.ts — même
// helper que le dashboard / la consolidation cash, même set d'enums canal) :
//   * déjà encaissé (collected/remitted/discrepancy) → NON réécrit (le cash figé
//     reste, l'écart vs le nouveau total se reflète via le mécanisme discrepancy) ;
//   * sinon → prépayé (WAVE/ORANGE_MONEY/FREE_MONEY) ⇒ 0 ; COD ⇒ round(total).
const COLLECTED_CASH_STATES = ['collected', 'remitted', 'discrepancy'] as const;

export const updateOrderAmountsAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'orders.update_amounts', section: 'orders' })
  .inputSchema(
    z.object({
      orderId: z.string().uuid(),
      totalAmount: positiveOrderTotalSchema,
      deliveryFeeMinor: z.number().int().min(0),
      scheduledFor: z.string().datetime().optional(),
    }),
  )
  .action(async ({ ctx, parsedInput }) => {
    const supabase = asTypedSupabaseClient(ctx.supabase);

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select(
        'id, merchant_account_id, cash_state, payment_channel_at_delivery, cash_collectable_minor',
      )
      .eq('id', parsedInput.orderId)
      .maybeSingle();

    if (orderError) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    if (!order) {
      return { ok: false as const, errorCode: 'order_not_found' as const };
    }

    const alreadyCollected = (COLLECTED_CASH_STATES as readonly string[]).includes(
      order.cash_state ?? '',
    );
    // stored=null force le recalcul canonique (canal + nouveau total) ; déjà
    // encaissé → on passe le cash figé pour qu'il soit conservé tel quel.
    const nextCashCollectable = cashCollectableMinor({
      cashCollectableMinor: alreadyCollected ? order.cash_collectable_minor : null,
      paymentChannel: order.payment_channel_at_delivery,
      totalAmount: parsedInput.totalAmount,
    });

    const patch: TablesUpdate<'orders'> = {
      total_amount: parsedInput.totalAmount,
      delivery_fee_minor: parsedInput.deliveryFeeMinor,
      cash_collectable_minor: nextCashCollectable,
      ...(parsedInput.scheduledFor ? { scheduled_for: parsedInput.scheduledFor } : {}),
    };

    const { error: updateError } = await supabase.from('orders').update(patch).eq('id', order.id);

    if (updateError) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    const auditError = await writeOrderAuditLog({
      action: 'order.amounts_updated',
      actorUserId: ctx.user.id,
      merchantAccountId: order.merchant_account_id,
      orderId: order.id,
      payload: {
        totalAmount: parsedInput.totalAmount,
        deliveryFeeMinor: parsedInput.deliveryFeeMinor,
        cashCollectableMinor: nextCashCollectable,
        scheduledForChanged: Boolean(parsedInput.scheduledFor),
      },
    });

    if (auditError) {
      return { ok: false as const, errorCode: 'audit_failed' as const };
    }

    revalidateOrderPaths(order.id);
    revalidatePath('/tableau');
    revalidatePath('/finances');
    revalidatePath('/livreurs');

    return { ok: true as const, orderId: order.id };
  });

// Phase 11.1 — lecture des détails/montants d'une commande pour le popup
// d'assignation (owner/manager). Sert le popup ouvert depuis la LISTE où
// OrderListItem ne porte pas delivery_fee_minor. RLS-scopé (client serveur).
type CartEditorProduct = { id: string; isActive: boolean; sku: string | null; title: string };

function parseCartSummary(value: Json | null): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const lines: Array<Record<string, unknown>> = [];
  for (const item of value) {
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      lines.push(item as Record<string, unknown>);
    }
  }
  return lines;
}

export const getOrderCartEditorDataAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'orders.cart_editor_data', section: 'orders' })
  .inputSchema(z.object({ orderId: z.string().uuid() }))
  .action(async ({ ctx, parsedInput }) => {
    const supabase = asTypedSupabaseClient(ctx.supabase);
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, merchant_account_id, delivery_state, cash_state, items_summary')
      .eq('id', parsedInput.orderId)
      .maybeSingle();
    if (orderError) return { ok: false as const, errorCode: 'load_failed' as const };
    if (!order) return { ok: false as const, errorCode: 'order_not_found' as const };
    const mode = getOrderCartEditingMode({
      cashState: order.cash_state,
      deliveryState: order.delivery_state,
    });
    if (!mode) {
      return { ok: false as const, errorCode: 'cart_edit_not_allowed' as const };
    }
    const [linesResult, productsResult] = await Promise.all([
      supabase
        .from('order_line')
        .select('product_id, qty, raw_title, raw_sku')
        .eq('order_id', order.id)
        .order('created_at', { ascending: true }),
      supabase
        .from('product')
        .select('id, title, sku, is_active')
        .eq('merchant_account_id', order.merchant_account_id)
        .order('title', { ascending: true }),
    ]);
    if (linesResult.error || productsResult.error)
      return { ok: false as const, errorCode: 'load_failed' as const };
    const products: CartEditorProduct[] = (productsResult.data ?? []).map((product) => ({
      id: product.id,
      isActive: product.is_active,
      sku: product.sku,
      title: product.title,
    }));
    const productById = new Map(products.map((product) => [product.id, product]));
    const summary = parseCartSummary(order.items_summary);
    const lines = (linesResult.data ?? []).map((line, index) => {
      const selected = line.product_id ? (productById.get(line.product_id) ?? null) : null;
      const source =
        summary.find(
          (item) =>
            (line.product_id !== null && item.product_id === line.product_id) ||
            (line.raw_sku !== null && item.sku === line.raw_sku),
        ) ?? summary[index];
      const price =
        typeof source?.price === 'number' && Number.isFinite(source.price) ? source.price : null;
      return {
        productId: selected?.isActive ? selected.id : null,
        productLabel: selected?.title ?? line.raw_title,
        quantity: line.qty,
        unitPrice: price,
        unresolvedReason: !line.product_id
          ? 'Cette ligne n’est pas résolue. Sélectionnez un produit du catalogue.'
          : !selected
            ? 'Le produit associé n’existe plus. Sélectionnez un produit actif.'
            : !selected.isActive
              ? 'Le produit associé est désactivé. Sélectionnez un produit actif.'
              : null,
      };
    });
    return {
      ok: true as const,
      lines,
      mode,
      products: products.filter((product) => product.isActive),
    };
  });

export const replaceOrderCartAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'orders.replace_cart', section: 'orders' })
  .inputSchema(
    z.object({
      orderId: z.string().uuid(),
      lines: z
        .array(
          z.object({
            productId: z.string().uuid(),
            quantity: z.number().int().min(1).max(999),
            unitPrice: z.number().min(0).max(Number.MAX_SAFE_INTEGER),
          }),
        )
        .min(1)
        .max(20),
    }),
  )
  .action(async ({ parsedInput, ctx }) => {
    const supabase = asTypedSupabaseClient(ctx.supabase);
    const { error } = await supabase.rpc('replace_order_cart', {
      p_order_id: parsedInput.orderId,
      p_lines: parsedInput.lines.map((line) => ({
        product_id: line.productId,
        quantity: line.quantity,
        unit_price: line.unitPrice,
      })),
    });
    if (error) {
      if (error.message === 'order_not_found')
        return { ok: false as const, errorCode: 'order_not_found' as const };
      if (error.message.includes('cart_edit_not_allowed'))
        return { ok: false as const, errorCode: 'cart_edit_not_allowed' as const };
      if (error.message === 'cart_product_not_found')
        return { ok: false as const, errorCode: 'cart_product_not_found' as const };
      return { ok: false as const, errorCode: 'update_failed' as const };
    }
    revalidateOrderPaths(parsedInput.orderId);
    revalidatePath('/tableau');
    return { ok: true as const, orderId: parsedInput.orderId };
  });

export const reduceOrderCartPostAssignmentAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'orders.reduce_cart_post_assignment', section: 'orders' })
  .inputSchema(
    z.object({
      orderId: z.string().uuid(),
      lines: z
        .array(
          z.object({
            productId: z.string().uuid(),
            quantity: z.number().int().min(1).max(999),
          }),
        )
        .min(1)
        .max(20),
    }),
  )
  .action(async ({ parsedInput, ctx }) => {
    const supabase = asTypedSupabaseClient(ctx.supabase);
    const { error } = await reduceOrderCartPostAssignmentRpc(supabase)(
      'reduce_order_cart_post_assignment',
      {
        p_order_id: parsedInput.orderId,
        p_lines: parsedInput.lines.map((line) => ({
          product_id: line.productId,
          quantity: line.quantity,
        })) as Json,
      },
    );
    if (error) {
      if (error.message === 'order_not_found')
        return { ok: false as const, errorCode: 'order_not_found' as const };
      if (error.message.includes('cart_reduction_not_allowed'))
        return { ok: false as const, errorCode: 'cart_edit_not_allowed' as const };
      if (error.message.includes('cart_reduction_'))
        return { ok: false as const, errorCode: 'invalid_reduction' as const };
      return { ok: false as const, errorCode: 'update_failed' as const };
    }
    revalidateOrderPaths(parsedInput.orderId);
    revalidatePath('/tableau');
    revalidatePath('/livreurs');
    revalidatePath('/finances');
    return { ok: true as const, orderId: parsedInput.orderId };
  });

type AssignmentLine = { title: string; quantity: number; price: number };

function parseAssignmentLines(value: Json | null): AssignmentLine[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const lines: AssignmentLine[] = [];
  for (const item of value) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      lines.push({
        title: typeof record.title === 'string' ? record.title : '',
        quantity: typeof record.quantity === 'number' ? record.quantity : 0,
        price: typeof record.price === 'number' ? record.price : 0,
      });
    }
  }
  return lines;
}

export const getOrderAmountsForAssignmentAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'orders.assignment_details', section: 'orders' })
  // driverId optionnel = livreur CHOISI dans le picker mais PAS encore assigné (le popup
  // s'ouvre avant la transition `assigner` depuis Phase 13.1). À défaut, on retombe sur le
  // livreur déjà assigné (réouverture d'une commande assignée).
  .inputSchema(z.object({ orderId: z.string().uuid(), driverId: z.string().uuid().optional() }))
  .action(async ({ ctx, parsedInput }) => {
    const supabase = asTypedSupabaseClient(ctx.supabase);
    const { data: order, error } = await supabase
      .from('orders')
      .select(
        'id, order_number, total_amount, delivery_fee_minor, scheduled_for, currency, items_summary, shipping_address, assigned_driver_id, customer:customer_id(full_name, phone)',
      )
      .eq('id', parsedInput.orderId)
      .maybeSingle();

    if (error) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    if (!order) {
      return { ok: false as const, errorCode: 'order_not_found' as const };
    }

    const customer = order.customer as { full_name: string | null; phone: string | null } | null;

    // Livreur (choisi ou déjà assigné) : nom + téléphone pour le lien WhatsApp d'expédition (C5).
    const driverLookupId = parsedInput.driverId ?? order.assigned_driver_id;
    let driverName: string | null = null;
    let driverPhone: string | null = null;
    if (driverLookupId) {
      const { data: driver } = await supabase
        .from('driver')
        .select('full_name, phone')
        .eq('id', driverLookupId)
        .maybeSingle();
      driverName = driver?.full_name ?? null;
      driverPhone = driver?.phone ?? null;
    }

    return {
      ok: true as const,
      data: {
        orderNumber: order.order_number,
        totalAmount: order.total_amount,
        deliveryFeeMinor: order.delivery_fee_minor,
        scheduledFor: order.scheduled_for,
        currency: order.currency,
        customerName: customer?.full_name ?? null,
        customerPhone: customer?.phone ?? null,
        deliveryAddress: formatOrderAddress(order.shipping_address),
        driverName,
        driverPhone,
        items: parseAssignmentLines(order.items_summary),
      },
    };
  });

// Lot 2 / PR 3 — besoins de stock d'une commande pour l'alerte informative "Stock
// insuffisant" du popup d'assignation. Agrège order_line par product_id, même
// prédicat exact que transition_order/reassign_order_driver (migration 0091) :
// match_status='matched' and product_id is not null. Lecture seule, ne déclenche
// aucune précondition serveur.
// Lot 2 / PR 4 — élargi à agent (RLS order_line_select autorise déjà owner/manager/agent,
// même prédicat, aucune donnée supplémentaire exposée) pour couvrir le chemin
// TransitionDialog. getDriverAvailableStock (PR 2) reste owner/manager only — cf.
// lib/actions/assignment-stock.ts pour le pendant agent du disponible.
export type OrderRequiredStockRow = {
  productId: string;
  title: string;
  requiredQty: number;
};

export type OrderRequiredStockData =
  | { ok: true; rows: OrderRequiredStockRow[] }
  | { ok: false; errorCode: 'read_failed' };

export const getOrderRequiredStockAction = requireRole('owner', 'manager', 'agent')
  .metadata({ actionName: 'orders.required_stock', section: 'orders' })
  .inputSchema(z.object({ orderId: z.string().uuid() }))
  .action(async ({ ctx, parsedInput }) => {
    const supabase = asTypedSupabaseClient(ctx.supabase);
    const { data: lines, error } = await supabase
      .from('order_line')
      .select('product_id, qty, match_status')
      .eq('order_id', parsedInput.orderId)
      .eq('match_status', 'matched')
      .not('product_id', 'is', null);

    if (error) {
      return { ok: false as const, errorCode: 'read_failed' as const };
    }

    const requiredByProduct = new Map<string, number>();
    for (const line of lines ?? []) {
      if (!line.product_id) continue;
      requiredByProduct.set(
        line.product_id,
        (requiredByProduct.get(line.product_id) ?? 0) + line.qty,
      );
    }

    if (requiredByProduct.size === 0) {
      return { ok: true as const, rows: [] };
    }

    const { data: products } = await supabase
      .from('product')
      .select('id, title')
      .in('id', [...requiredByProduct.keys()]);

    const productTitles = new Map((products ?? []).map((p) => [p.id, p.title]));

    const rows: OrderRequiredStockRow[] = [...requiredByProduct.entries()].map(
      ([productId, requiredQty]) => ({
        productId,
        title: productTitles.get(productId) ?? 'Produit inconnu',
        requiredQty,
      }),
    );

    return { ok: true as const, rows };
  });

// Phase 11 — réassignation du livreur. Délègue au RPC SECURITY INVOKER
// reassign_order_driver (0058) : swap atomique de assigned_driver_id + compensation
// stock (courier_return X / dispatch Y, qty_reserved INCHANGÉ) si le dispatch est
// déjà posté ; interdit après livraison. Le retransfert cash/livraison est
// automatique par dérivation du assigned_driver_id courant. Owner/manager.
type ReassignOrderDriverArgs = Database['public']['Functions']['reassign_order_driver']['Args'];

function reassignOrderDriverRpc(client: SupabaseServerClient) {
  return client.rpc.bind(client) as unknown as (
    fn: 'reassign_order_driver',
    args: ReassignOrderDriverArgs,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
}

function reassignErrorMessage(raw: string): string {
  if (raw.includes('reassign_not_allowed_in_state')) {
    return 'Réassignation impossible : la commande est livrée ou clôturée.';
  }
  if (raw.includes('reassign_missing_outgoing_driver')) {
    return 'Aucun livreur sortant à transférer.';
  }
  if (raw.includes('driver not found')) {
    return 'Livreur introuvable pour ce compte.';
  }
  if (raw.includes('order_not_found')) {
    return 'Commande introuvable.';
  }
  if (raw.includes('reassign movement requires a driver')) {
    return 'Livreur manquant pour tracer le transfert de stock.';
  }
  if (raw.includes('stock_movement_type_check') || raw.includes('unknown stock movement_type')) {
    return "Réassignation impossible : le suivi de stock n'a pas pu être enregistré.";
  }
  return 'La réassignation a échoué.';
}

export const reassignOrderDriverAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'orders.reassign_driver', section: 'orders' })
  .inputSchema(
    z.object({
      orderId: z.string().uuid(),
      newDriverId: z.string().uuid(),
    }),
  )
  .action(async ({ ctx, parsedInput }) => {
    const supabase = asTypedSupabaseClient(ctx.supabase);

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, merchant_account_id, assigned_driver_id')
      .eq('id', parsedInput.orderId)
      .maybeSingle();

    if (orderError) {
      return {
        ok: false as const,
        errorCode: 'update_failed' as const,
        message: "La commande n'a pas pu être chargée.",
      };
    }

    if (!order) {
      return {
        ok: false as const,
        errorCode: 'order_not_found' as const,
        message: 'Commande introuvable.',
      };
    }

    const reassign = reassignOrderDriverRpc(supabase);
    const { error } = await reassign('reassign_order_driver', {
      p_order_id: parsedInput.orderId,
      p_actor: ctx.user.id,
      p_new_driver: parsedInput.newDriverId,
    });

    if (error) {
      return {
        ok: false as const,
        errorCode: 'reassign_failed' as const,
        message: reassignErrorMessage(error.message),
      };
    }

    const auditError = await writeOrderAuditLog({
      action: 'order.driver_reassigned',
      actorUserId: ctx.user.id,
      merchantAccountId: order.merchant_account_id,
      orderId: order.id,
      payload: {
        fromDriverId: order.assigned_driver_id,
        toDriverId: parsedInput.newDriverId,
      },
    });

    if (auditError) {
      return {
        ok: false as const,
        errorCode: 'audit_failed' as const,
        message: 'Réassignation effectuée mais journalisation en échec.',
      };
    }

    revalidateOrderPaths(order.id);
    revalidatePath('/livreurs');
    revalidatePath('/tableau');

    return { ok: true as const };
  });
