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
type ReportDriverCashPendingRow =
  Database['public']['Functions']['get_report_driver_cash_pending']['Returns'][number];
type ReportStatusBreakdownRow =
  Database['public']['Functions']['get_report_status_breakdown']['Returns'][number];
type ReportRevenueByDayRow =
  Database['public']['Functions']['get_report_revenue_by_day']['Returns'][number];
type ReportTopProductRow =
  Database['public']['Functions']['get_report_top_products']['Returns'][number];
type CodStatus = Tables<'orders'>['cod_status'];
type SettlementMethod = SettlementForMargin['method'];

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
    id: string | null;
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

function reportDriverCashPendingRpc(supabase: SupabaseServerClient) {
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: 'get_report_driver_cash_pending',
    args: { p_from: string; p_merchant_id: string; p_shop_id?: string | null; p_to: string },
  ) => Promise<{ data: ReportDriverCashPendingRow[] | null; error: unknown }>;

  return rpc;
}

function reportStatusBreakdownRpc(supabase: SupabaseServerClient) {
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: 'get_report_status_breakdown',
    args: { p_from: string; p_merchant_id: string; p_shop_id?: string | null; p_to: string },
  ) => Promise<{ data: ReportStatusBreakdownRow[] | null; error: unknown }>;

  return rpc;
}

function reportRevenueByDayRpc(supabase: SupabaseServerClient) {
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: 'get_report_revenue_by_day',
    args: { p_from: string; p_merchant_id: string; p_shop_id?: string | null; p_to: string },
  ) => Promise<{ data: ReportRevenueByDayRow[] | null; error: unknown }>;

  return rpc;
}

function reportTopProductsRpc(supabase: SupabaseServerClient) {
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: 'get_report_top_products',
    args: { p_from: string; p_merchant_id: string; p_shop_id?: string | null; p_to: string },
  ) => Promise<{ data: ReportTopProductRow[] | null; error: unknown }>;

  return rpc;
}

function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

// Pré-population de la série continue [from,to] à 0 (comportement actuel inchangé), puis fusion
// des lignes get_report_revenue_by_day (migration 0085) par clé de jour. Une commande dont le
// bucket (coalesce(updated_at,created_at), UTC) tombe hors [from,to] ajoute une clé hors série
// pré-peuplée, comme aujourd'hui (RPC ne filtre pas la date de bucket, seulement created_at).
function buildRevenueSeries(
  rows: ReportRevenueByDayRow[],
  from: Date,
  to: Date,
): ReportRevenuePoint[] {
  const points = new Map<string, number>();
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);

  while (cursor <= end) {
    points.set(dateKey(cursor), 0);
    cursor.setDate(cursor.getDate() + 1);
  }

  for (const row of rows) {
    points.set(row.day, (points.get(row.day) ?? 0) + row.amount_minor);
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
  from: _from,
  shopSlug: _shopSlug,
  to: _to,
}: {
  from: Date;
  shopSlug: string;
  to: Date;
}): string {
  return 'teer-rapport.pdf';
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

  // currency (data affichée mais inerte : formatMoneyPdf/formatMoney ignore le paramètre
  // _currency) : source déterministe validée pour Lot 4 — dernière commande créée de la
  // fenêtre (created_at desc, id asc en tie-break), même filtre merchant+période+shop que les
  // agrégats ci-dessous, bornée à 1 ligne. Remplace l'ancien orders[0]?.currency non déterministe
  // (résultat non ordonné, potentiellement tronqué à 1000 lignes).
  const currencyBaseQuery = supabase
    .from('orders')
    .select('currency')
    .eq('merchant_account_id', merchantAccountId)
    .gte('created_at', fromIso)
    .lte('created_at', toIso);

  const currencyQuery = (shopId ? currencyBaseQuery.eq('shop_id', shopId) : currencyBaseQuery)
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })
    .limit(1);

  const [
    merchantResult,
    shopsResult,
    kpisResult,
    agingResult,
    settingsResult,
    currencyResult,
    settlementsResult,
    driversResult,
    shortfallsResult,
    driverCashPendingResult,
    statusBreakdownResult,
    revenueByDayResult,
    topProductsResult,
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
    currencyQuery,
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
    reportDriverCashPendingRpc(supabase)('get_report_driver_cash_pending', {
      p_from: fromIso,
      p_merchant_id: merchantAccountId,
      p_shop_id: shopId ?? null,
      p_to: toIso,
    }),
    reportStatusBreakdownRpc(supabase)('get_report_status_breakdown', {
      p_from: fromIso,
      p_merchant_id: merchantAccountId,
      p_shop_id: shopId ?? null,
      p_to: toIso,
    }),
    reportRevenueByDayRpc(supabase)('get_report_revenue_by_day', {
      p_from: fromIso,
      p_merchant_id: merchantAccountId,
      p_shop_id: shopId ?? null,
      p_to: toIso,
    }),
    reportTopProductsRpc(supabase)('get_report_top_products', {
      p_from: fromIso,
      p_merchant_id: merchantAccountId,
      p_shop_id: shopId ?? null,
      p_to: toIso,
    }),
  ]);

  if (
    merchantResult.error ||
    shopsResult.error ||
    kpisResult.error ||
    agingResult.error ||
    settingsResult.error ||
    currencyResult.error ||
    settlementsResult.error ||
    driversResult.error ||
    shortfallsResult.error ||
    driverCashPendingResult.error ||
    statusBreakdownResult.error ||
    revenueByDayResult.error ||
    topProductsResult.error
  ) {
    throw new Error('REPORT_DATA_FAILED');
  }

  const merchant = merchantResult.data as MerchantRow | null;
  const shops = (shopsResult.data ?? []) as ShopRow[];
  const selectedShop = shopId ? shops.find((shop) => shop.id === shopId) : shops[0];
  if (shopId && !selectedShop) {
    throw new Error('FORBIDDEN');
  }
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
    delivered_orders_count: 0,
    encaisse: 0,
    taux_refus: 0,
  };
  const statusBreakdownByStatus = new Map(
    ((statusBreakdownResult.data ?? []) as ReportStatusBreakdownRow[]).map((row) => [
      row.cod_status as CodStatus,
      row,
    ]),
  );
  // 0119 : marginMinor doit utiliser le MÊME compte de livraisons que ca_livre (kpis.ca_livre,
  // finance_kpis — désormais daté sur cash_collected_at), pas statusBreakdownByStatus (
  // get_report_status_breakdown, fenêtré sur created_at — reste volontairement tel quel pour
  // statuses[] ci-dessous, un autre usage : répartition des commandes CRÉÉES dans la période).
  // Mélanger un ca_livre daté cash_collected_at avec un delivered_orders_count daté created_at
  // aurait réintroduit la même incohérence que ce lot corrige côté finance_kpis.
  const marginMinor = estimatedMarginMinor({
    caLivreMinor: kpis.ca_livre,
    deliveredOrdersCount: kpis.delivered_orders_count,
    settlements,
    settings,
  });
  const totalOrders =
    [...statusBreakdownByStatus.values()].reduce((total, row) => total + row.count, 0) || 1;
  const statuses = codStatuses.map((status) => {
    const matching = statusBreakdownByStatus.get(status);
    const amountMinor = matching?.amount_minor ?? 0;

    return {
      amountMinor,
      count: matching?.count ?? 0,
      percent: (matching?.count ?? 0) / totalOrders,
      status,
    };
  });
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

  // Cash chez le livreur PENDING (périmètre PDF : commandes créées dans [from,to],
  // boutique optionnelle — ≠ le cash total en main cross-boutique all-time des autres
  // surfaces, cf. migration 0083) via la RPC get_report_driver_cash_pending (migration
  // 0084), même arithmétique agrégée que deriveDriverCashConsolidation/
  // consolidateCashByDriver mais calculée en SQL — plus de select `orders` fenêtré sans
  // `.range()` (cap PostgREST 1000) ni de `.in(orderIds)` sur settlement_allocation.
  for (const row of (driverCashPendingResult.data ?? []) as ReportDriverCashPendingRow[]) {
    if (row.pending_minor <= 0) {
      continue;
    }
    const current = driverRows.get(row.driver_id) ?? {
      driverId: row.driver_id,
      driverName: driversById.get(row.driver_id) ?? row.driver_name ?? 'Livreur',
      pendingMinor: 0,
      settledMinor: 0,
      shortfallMinor: 0,
    };
    current.pendingMinor += row.pending_minor;
    driverRows.set(row.driver_id, current);
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
    currency: currencyResult.data?.[0]?.currency ?? 'XOF',
    drivers: [...driverRows.values()].sort(
      (left, right) =>
        right.pendingMinor + right.shortfallMinor - (left.pendingMinor + left.shortfallMinor),
    ),
    from,
    generatedAt: new Date(),
    kpis: { ...kpis, margin_estimee: marginMinor },
    methods: [...methods.values()].sort((left, right) => right.settledMinor - left.settledMinor),
    profit,
    revenue: buildRevenueSeries(
      (revenueByDayResult.data ?? []) as ReportRevenueByDayRow[],
      from,
      to,
    ),
    shop: {
      domain: selectedShop?.shop_domain ?? null,
      id: selectedShop?.id ?? null,
      name: shopName,
      slug: slugify(shopName),
    },
    statuses,
    to,
    topProducts: ((topProductsResult.data ?? []) as ReportTopProductRow[]).map((row) => ({
      amountMinor: row.amount_minor,
      quantity: row.quantity,
      title: row.title,
    })),
  };
}
