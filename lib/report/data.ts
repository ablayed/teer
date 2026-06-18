import { consolidateCashByDriver } from '@/lib/drivers/cash-consolidation';
import {
  type MerchantFeeSettings,
  type SettlementForMargin,
  digitalSettlementFeesMinor,
  estimatedMarginMinor,
} from '@/lib/finance/fees';
import type { FinanceReport } from '@/lib/finance/profit';
import { createFinanceAdminClient, fetchFinanceReport } from '@/lib/finance/report-data';
import type { Database, Tables } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';

type SupabaseServerClient = SupabaseClient<Database>;
type FinanceKpiRow = Database['public']['Functions']['finance_kpis']['Returns'][number];
type CashAgingRow = Database['public']['Functions']['cash_aging']['Returns'][number];
type CodStatus = Tables<'orders'>['cod_status'];
type SettlementMethod = SettlementForMargin['method'];

type ReportOrderRow = Pick<
  Tables<'orders'>,
  | 'assigned_driver_id'
  | 'cash_collectable_minor'
  | 'cash_state'
  | 'cod_status'
  | 'created_at'
  | 'currency'
  | 'delivery_fee_minor'
  | 'id'
  | 'items_summary'
  | 'order_number'
  | 'payment_channel_at_delivery'
  | 'shop_id'
  | 'total_amount'
  | 'updated_at'
>;

type AllocationRow = Pick<Tables<'settlement_allocation'>, 'allocated_minor' | 'order_id'>;
type DriverRow = Pick<Tables<'driver'>, 'full_name' | 'id'>;
type ShortfallRow = Pick<
  Tables<'settlement_shortfall'>,
  'driver_id' | 'resolution' | 'shortfall_minor'
>;
type ShopRow = Pick<Tables<'shop'>, 'id' | 'shop_domain'>;
type MerchantRow = Pick<Tables<'merchant_account'>, 'name'>;

export type ReportStatusSummary = {
  amountMinor: number;
  count: number;
  percent: number;
  status: CodStatus;
};

export type ReportRevenuePoint = {
  date: string;
  valueMinor: number;
};

export type ReportTopProduct = {
  amountMinor: number;
  quantity: number;
  title: string;
};

export type ReportDriverReconciliation = {
  driverId: string;
  driverName: string;
  pendingMinor: number;
  settledMinor: number;
  shortfallMinor: number;
};

export type ReportMethodFees = {
  feeMinor: number;
  method: SettlementMethod;
  settledMinor: number;
};

export type ReportData = {
  cashAging: CashAgingRow[];
  currency: string;
  drivers: ReportDriverReconciliation[];
  from: Date;
  generatedAt: Date;
  kpis: FinanceKpiRow & { margin_estimee: number };
  methods: ReportMethodFees[];
  // Compte de résultat (P&L) returns-aware — owner-only ; null pour un manager.
  profit: FinanceReport | null;
  revenue: ReportRevenuePoint[];
  shop: {
    domain: string | null;
    name: string;
    slug: string;
  };
  statuses: ReportStatusSummary[];
  to: Date;
  topProducts: ReportTopProduct[];
};

const defaultSettings: MerchantFeeSettings = {
  cogs_known: false,
  default_delivery_cost_minor: 0,
  free_money_fee_bps: 100,
  merchant_levy_bps: 50,
  orange_money_fee_bps: 100,
  transfer_tax_bps: 50,
  transfer_tax_cap_minor: 2_000,
  wave_fee_bps: 100,
};

const codStatuses: CodStatus[] = [
  'A_APPELER',
  'TENTEE',
  'CONFIRMEE',
  'PROGRAMMEE',
  'EN_LIVRAISON',
  'LIVREE',
  'REFUSEE',
  'ANNULEE',
];

function financeKpisRpc(supabase: SupabaseServerClient) {
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: 'finance_kpis',
    args: { p_from: string; p_merchant: string; p_shop_id?: string | null; p_to: string },
  ) => Promise<{ data: FinanceKpiRow[] | null; error: unknown }>;

  return rpc;
}

function cashAgingRpc(supabase: SupabaseServerClient) {
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: 'cash_aging',
    args: { p_merchant: string },
  ) => Promise<{ data: CashAgingRow[] | null; error: unknown }>;

  return rpc;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function itemPriceMinor(item: Record<string, unknown>): number {
  const price = numberField(item, 'price');
  const priceMinor = numberField(item, 'price_minor');

  return Math.round(priceMinor > 0 ? priceMinor : price);
}

function aggregateTopProducts(orders: ReportOrderRow[]): ReportTopProduct[] {
  const byTitle = new Map<string, ReportTopProduct>();

  for (const order of orders) {
    if (!Array.isArray(order.items_summary)) {
      continue;
    }

    for (const item of order.items_summary) {
      if (!isRecord(item)) {
        continue;
      }

      const title = stringField(item, 'title') ?? 'Produit';
      const quantity = Math.max(Math.round(numberField(item, 'quantity')), 0);
      const amountMinor = itemPriceMinor(item) * quantity;
      const current = byTitle.get(title) ?? { amountMinor: 0, quantity: 0, title };
      current.quantity += quantity;
      current.amountMinor += amountMinor;
      byTitle.set(title, current);
    }
  }

  return [...byTitle.values()]
    .sort((left, right) => right.amountMinor - left.amountMinor || right.quantity - left.quantity)
    .slice(0, 10);
}

function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function aggregateRevenue(orders: ReportOrderRow[], from: Date, to: Date): ReportRevenuePoint[] {
  const points = new Map<string, number>();
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);

  while (cursor <= end) {
    points.set(dateKey(cursor), 0);
    cursor.setDate(cursor.getDate() + 1);
  }

  for (const order of orders) {
    if (order.cod_status !== 'LIVREE') {
      continue;
    }

    const key = dateKey(new Date(order.updated_at ?? order.created_at));
    points.set(key, (points.get(key) ?? 0) + Math.round(order.total_amount));
  }

  return [...points.entries()].map(([date, valueMinor]) => ({ date, valueMinor }));
}

function slugify(value: string): string {
  const slug = value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'boutique';
}

function toSettings(row: Partial<MerchantFeeSettings> | null): MerchantFeeSettings {
  return row
    ? {
        cogs_known: row.cogs_known ?? defaultSettings.cogs_known,
        default_delivery_cost_minor:
          row.default_delivery_cost_minor ?? defaultSettings.default_delivery_cost_minor,
        free_money_fee_bps: row.free_money_fee_bps ?? defaultSettings.free_money_fee_bps,
        merchant_levy_bps: row.merchant_levy_bps ?? defaultSettings.merchant_levy_bps,
        orange_money_fee_bps: row.orange_money_fee_bps ?? defaultSettings.orange_money_fee_bps,
        transfer_tax_bps: row.transfer_tax_bps ?? defaultSettings.transfer_tax_bps,
        transfer_tax_cap_minor:
          row.transfer_tax_cap_minor ?? defaultSettings.transfer_tax_cap_minor,
        wave_fee_bps: row.wave_fee_bps ?? defaultSettings.wave_fee_bps,
      }
    : defaultSettings;
}

async function getReportContext() {
  const supabase = (await createSupabaseServerClient()) as unknown as SupabaseServerClient;
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error('UNAUTHENTICATED');
  }

  const { data: member, error } = await supabase
    .from('merchant_member')
    .select('merchant_account_id, role')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();

  if (error || !member || !['owner', 'manager'].includes(member.role)) {
    throw new Error('FORBIDDEN');
  }

  return { merchantAccountId: member.merchant_account_id, role: member.role, supabase };
}

export function reportFilename({
  from,
  shopSlug,
  to,
}: {
  from: Date;
  shopSlug: string;
  to: Date;
}): string {
  return `teer-rapport-${shopSlug}-${dateKey(from)}_${dateKey(to)}.pdf`;
}

export async function getReportData({
  from,
  shopId,
  to,
}: {
  from: Date;
  shopId?: string | null;
  to: Date;
}): Promise<ReportData> {
  const { merchantAccountId, role, supabase } = await getReportContext();
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  const ordersQuery = supabase
    .from('orders')
    .select(
      'id, shop_id, order_number, total_amount, currency, cod_status, items_summary, assigned_driver_id, payment_channel_at_delivery, cash_collectable_minor, cash_state, delivery_fee_minor, created_at, updated_at',
    )
    .eq('merchant_account_id', merchantAccountId)
    .gte('created_at', fromIso)
    .lte('created_at', toIso);

  const scopedOrdersQuery = shopId ? ordersQuery.eq('shop_id', shopId) : ordersQuery;

  const [
    merchantResult,
    shopsResult,
    kpisResult,
    agingResult,
    settingsResult,
    ordersResult,
    settlementsResult,
    driversResult,
    shortfallsResult,
  ] = await Promise.all([
    supabase.from('merchant_account').select('name').eq('id', merchantAccountId).maybeSingle(),
    supabase.from('shop').select('id, shop_domain').eq('merchant_account_id', merchantAccountId),
    financeKpisRpc(supabase)('finance_kpis', {
      p_from: fromIso,
      p_merchant: merchantAccountId,
      p_shop_id: shopId ?? null,
      p_to: toIso,
    }),
    cashAgingRpc(supabase)('cash_aging', { p_merchant: merchantAccountId }),
    supabase
      .from('merchant_settings')
      .select('*')
      .eq('merchant_account_id', merchantAccountId)
      .maybeSingle(),
    scopedOrdersQuery,
    supabase
      .from('cash_settlement')
      .select('amount_received_minor, driver_id, method')
      .eq('merchant_account_id', merchantAccountId)
      .gte('settled_at', fromIso)
      .lte('settled_at', toIso),
    supabase.from('driver').select('id, full_name').eq('merchant_account_id', merchantAccountId),
    supabase
      .from('settlement_shortfall')
      .select('driver_id, resolution, shortfall_minor')
      .eq('merchant_account_id', merchantAccountId),
  ]);

  if (
    merchantResult.error ||
    shopsResult.error ||
    kpisResult.error ||
    agingResult.error ||
    settingsResult.error ||
    ordersResult.error ||
    settlementsResult.error ||
    driversResult.error ||
    shortfallsResult.error
  ) {
    throw new Error('REPORT_DATA_FAILED');
  }

  const orders = (ordersResult.data ?? []) as ReportOrderRow[];
  const orderIds = orders.map((order) => order.id);
  const allocationsResult =
    orderIds.length > 0
      ? await supabase
          .from('settlement_allocation')
          .select('order_id, allocated_minor')
          .eq('merchant_account_id', merchantAccountId)
          .in('order_id', orderIds)
      : { data: [], error: null };

  if (allocationsResult.error) {
    throw new Error('REPORT_DATA_FAILED');
  }

  const merchant = merchantResult.data as MerchantRow | null;
  const shops = (shopsResult.data ?? []) as ShopRow[];
  const selectedShop = shopId ? shops.find((shop) => shop.id === shopId) : shops[0];
  const settings = toSettings(settingsResult.data as Partial<MerchantFeeSettings> | null);
  const settlements = (
    (settlementsResult.data ?? []) as Array<{
      amount_received_minor: number;
      driver_id: string;
      method: SettlementMethod;
    }>
  ).map((settlement) => ({
    amountReceivedMinor: settlement.amount_received_minor,
    driverId: settlement.driver_id,
    method: settlement.method,
  }));
  const kpis = kpisResult.data?.[0] ?? {
    a_encaisser: 0,
    ca_livre: 0,
    cash_chez_livreurs: 0,
    encaisse: 0,
    taux_refus: 0,
  };
  const deliveredOrdersCount = orders.filter((order) => order.cod_status === 'LIVREE').length;
  const marginMinor = estimatedMarginMinor({
    caLivreMinor: kpis.ca_livre,
    deliveredOrdersCount,
    settlements,
    settings,
  });
  const totalOrders = orders.length || 1;
  const statuses = codStatuses.map((status) => {
    const matching = orders.filter((order) => order.cod_status === status);
    const amountMinor = matching.reduce(
      (total, order) => total + Math.round(order.total_amount),
      0,
    );

    return {
      amountMinor,
      count: matching.length,
      percent: matching.length / totalOrders,
      status,
    };
  });
  const allocatedByOrder = new Map<string, number>();

  for (const allocation of (allocationsResult.data ?? []) as AllocationRow[]) {
    allocatedByOrder.set(
      allocation.order_id,
      (allocatedByOrder.get(allocation.order_id) ?? 0) + allocation.allocated_minor,
    );
  }

  const driversById = new Map(
    ((driversResult.data ?? []) as DriverRow[]).map((driver) => [driver.id, driver.full_name]),
  );
  const driverRows = new Map<string, ReportDriverReconciliation>();

  for (const settlement of settlements) {
    const current = driverRows.get(settlement.driverId) ?? {
      driverId: settlement.driverId,
      driverName: driversById.get(settlement.driverId) ?? 'Livreur',
      pendingMinor: 0,
      settledMinor: 0,
      shortfallMinor: 0,
    };
    current.settledMinor += settlement.amountReceivedMinor;
    driverRows.set(settlement.driverId, current);
  }

  // Cash chez le livreur NET = collecté − frais − remis, via le helper PARTAGÉ
  // consolidateCashByDriver (même arithmétique agrégée que la page Livreurs, le panneau
  // Finances et la card finance_kpis SQL — migration 0065). On retranche les frais de
  // livraison (le livreur les garde) et on clampe par livreur, jamais par commande.
  // Périmètre du rapport (commandes créées dans [from,to], boutique optionnelle) — c'est
  // l'axe propre au PDF ; la FORMULE est identique aux autres surfaces.
  const consolidations = consolidateCashByDriver(
    orders
      .filter((order) => order.assigned_driver_id !== null)
      .map((order) => ({
        driverId: order.assigned_driver_id as string,
        orderId: order.id,
        deliveryFeeMinor: order.delivery_fee_minor,
        cashState: order.cash_state,
        cashCollectableMinor: order.cash_collectable_minor,
        paymentChannel: order.payment_channel_at_delivery,
        totalAmount: order.total_amount,
      })),
    allocatedByOrder,
  );

  for (const [driverId, consolidation] of consolidations) {
    if (consolidation.cashOnHandMinor <= 0) {
      continue;
    }
    const current = driverRows.get(driverId) ?? {
      driverId,
      driverName: driversById.get(driverId) ?? 'Livreur',
      pendingMinor: 0,
      settledMinor: 0,
      shortfallMinor: 0,
    };
    current.pendingMinor += consolidation.cashOnHandMinor;
    driverRows.set(driverId, current);
  }

  for (const shortfall of (shortfallsResult.data ?? []) as ShortfallRow[]) {
    if (shortfall.resolution !== 'ROLLED_FORWARD') {
      continue;
    }

    const current = driverRows.get(shortfall.driver_id) ?? {
      driverId: shortfall.driver_id,
      driverName: driversById.get(shortfall.driver_id) ?? 'Livreur',
      pendingMinor: 0,
      settledMinor: 0,
      shortfallMinor: 0,
    };
    current.shortfallMinor += shortfall.shortfall_minor ?? 0;
    driverRows.set(shortfall.driver_id, current);
  }

  const methods = new Map<SettlementMethod, ReportMethodFees>();

  for (const settlement of settlements) {
    const current = methods.get(settlement.method) ?? {
      feeMinor: 0,
      method: settlement.method,
      settledMinor: 0,
    };
    current.settledMinor += settlement.amountReceivedMinor;
    current.feeMinor += digitalSettlementFeesMinor(settlement, settings);
    methods.set(settlement.method, current);
  }

  const shopName = merchant?.name ?? selectedShop?.shop_domain ?? 'Boutique';

  // Compte de résultat P&L — owner-only (unit_cost caché aux non-owner → service role).
  let profit: FinanceReport | null = null;
  if (role === 'owner') {
    try {
      profit = await fetchFinanceReport(
        createFinanceAdminClient(),
        merchantAccountId,
        fromIso,
        toIso,
        shopId ?? null,
      );
    } catch {
      profit = null;
    }
  }

  return {
    cashAging: agingResult.data ?? [],
    currency: orders[0]?.currency ?? 'XOF',
    drivers: [...driverRows.values()].sort(
      (left, right) =>
        right.pendingMinor + right.shortfallMinor - (left.pendingMinor + left.shortfallMinor),
    ),
    from,
    generatedAt: new Date(),
    kpis: { ...kpis, margin_estimee: marginMinor },
    methods: [...methods.values()].sort((left, right) => right.settledMinor - left.settledMinor),
    profit,
    revenue: aggregateRevenue(orders, from, to),
    shop: {
      domain: selectedShop?.shop_domain ?? null,
      name: shopName,
      slug: slugify(shopName),
    },
    statuses,
    to,
    topProducts: aggregateTopProducts(orders),
  };
}
