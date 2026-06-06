import { DriverSettlementsLoader } from '@/components/finance/DriverSettlementsLoader';
import type {
  FinanceDriverOutstanding,
  FinanceShortfall,
} from '@/components/finance/DriverSettlementsPanel';
import { ExpenseSection } from '@/components/finance/ExpenseSection';
import { FinanceChartsLoader } from '@/components/finance/FinanceChartsLoader';
import { ProfitSection } from '@/components/finance/ProfitSection';
import { ReportDownloadButton } from '@/components/finance/ReportDownloadButton';
import { getCodBreakdown, getRevenue30d, getShopPerformance } from '@/lib/actions/dashboard';
import { listExpenseCategoriesAction, listExpensesAction } from '@/lib/actions/expenses';
import { getFinanceReportAction } from '@/lib/actions/profit';
import { cashCollectableMinor } from '@/lib/finance/cash';
import {
  type MerchantFeeSettings,
  type SettlementForMargin,
  estimatedMarginMinor,
} from '@/lib/finance/fees';
import { formatMoney } from '@/lib/format/fcfa';
import type { Database } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AlertCircle, ArrowRight, LockKeyhole, Wallet } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

type FinanceKpiRow = Database['public']['Functions']['finance_kpis']['Returns'][number];
type CashAgingRow = Database['public']['Functions']['cash_aging']['Returns'][number];
type FinanceOrderRow = {
  assigned_driver_id: string | null;
  cash_collectable_minor: number | null;
  created_at: string;
  id: string;
  order_number: string | null;
  payment_channel_at_delivery: string | null;
  total_amount: number;
  updated_at: string;
};
type AllocationRow = {
  allocated_minor: number;
  order_id: string;
};
type DriverRow = {
  full_name: string;
  id: string;
  phone: string;
};
type ShortfallRow = {
  driver_id: string;
  id: string;
  reason: string | null;
  shortfall_minor: number;
};

type FinancesPageProps = {
  searchParams: Promise<{
    from?: string;
    period?: string;
    to?: string;
  }>;
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

function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function parseDateInput(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }

  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function periodRange({
  from,
  period,
  to,
}: {
  from?: string;
  period?: string;
  to?: string;
}): { activePeriod: string; from: Date; to: Date } {
  const now = new Date();
  const end = now;
  const customFrom = parseDateInput(from);
  const customTo = parseDateInput(to);

  if (customFrom && customTo) {
    customTo.setHours(23, 59, 59, 999);
    return { activePeriod: 'custom', from: customFrom, to: customTo };
  }

  if (period === 'today') {
    return { activePeriod: 'today', from: startOfDay(now), to: end };
  }

  const days = period === '7j' ? 7 : 30;
  const start = startOfDay(now);
  start.setDate(start.getDate() - (days - 1));

  return { activePeriod: days === 7 ? '7j' : '30j', from: start, to: end };
}

function toDateInput(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function kpiCard(label: string, value: string, description?: string) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5">
      <p className="text-[13px] font-medium text-muted">{label}</p>
      <p className="mt-2 font-mono text-2xl font-semibold tabular-nums md:text-3xl">{value}</p>
      {description ? <p className="mt-2 text-sm text-muted">{description}</p> : null}
    </section>
  );
}

function financeKpisRpc(supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>) {
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: 'finance_kpis',
    args: { p_from: string; p_merchant: string; p_to: string },
  ) => Promise<{ data: FinanceKpiRow[] | null; error: unknown }>;

  return rpc;
}

function cashAgingRpc(supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>) {
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: 'cash_aging',
    args: { p_merchant: string },
  ) => Promise<{ data: CashAgingRow[] | null; error: unknown }>;

  return rpc;
}

function paymentChannelIsCash(channel: string | null): boolean {
  return channel === null || channel === 'ESPECES' || channel === 'INCONNU';
}

async function getCurrentMember() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { merchantAccountId: null, role: null, supabase };
  }

  const { data: member } = await supabase
    .from('merchant_member')
    .select('merchant_account_id, role')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();

  const currentMember = member as { merchant_account_id: string; role: string } | null;

  return {
    merchantAccountId: currentMember?.merchant_account_id ?? null,
    role: currentMember?.role ?? null,
    supabase,
  };
}

export default async function FinancesPage({ searchParams }: FinancesPageProps) {
  const t = await getTranslations('finance');
  const params = await searchParams;
  const { activePeriod, from, to } = periodRange(params);
  const { merchantAccountId, role, supabase } = await getCurrentMember();

  if (!merchantAccountId || role !== 'owner') {
    return (
      <main className="space-y-6" id="main">
        <header className="space-y-2">
          <h1 className="font-display text-4xl md:text-5xl">{t('title')}</h1>
        </header>
        <section className="flex max-w-2xl gap-3 rounded-lg border border-border bg-surface p-5 text-muted shadow-1">
          <LockKeyhole aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <p>{t('restricted')}</p>
        </section>
      </main>
    );
  }

  const [
    kpisResult,
    agingResult,
    settingsResult,
    settlementsResult,
    deliveredCountResult,
    revenueResult,
    codBreakdownResult,
    shopPerformanceResult,
  ] = await Promise.all([
    financeKpisRpc(supabase)('finance_kpis', {
      p_from: from.toISOString(),
      p_merchant: merchantAccountId,
      p_to: to.toISOString(),
    }),
    cashAgingRpc(supabase)('cash_aging', { p_merchant: merchantAccountId }),
    supabase
      .from('merchant_settings')
      .select('*')
      .eq('merchant_account_id', merchantAccountId)
      .maybeSingle(),
    supabase
      .from('cash_settlement')
      .select('amount_received_minor, method')
      .eq('merchant_account_id', merchantAccountId)
      .gte('settled_at', from.toISOString())
      .lte('settled_at', to.toISOString()),
    supabase
      .from('order_state_transition')
      .select('id', { count: 'exact', head: true })
      .eq('merchant_account_id', merchantAccountId)
      .eq('to_status', 'LIVREE')
      .gte('created_at', from.toISOString())
      .lte('created_at', to.toISOString()),
    getRevenue30d(),
    getCodBreakdown(),
    getShopPerformance(),
  ]);

  const [outstandingOrdersResult, driversResult, shortfallsResult] = await Promise.all([
    supabase
      .from('orders')
      .select(
        'id, order_number, total_amount, cash_collectable_minor, payment_channel_at_delivery, assigned_driver_id, created_at, updated_at',
      )
      .eq('merchant_account_id', merchantAccountId)
      .eq('cod_status', 'LIVREE')
      .not('assigned_driver_id', 'is', null),
    supabase
      .from('driver')
      .select('id, full_name, phone')
      .eq('merchant_account_id', merchantAccountId),
    supabase
      .from('settlement_shortfall')
      .select('id, driver_id, reason, shortfall_minor')
      .eq('merchant_account_id', merchantAccountId)
      .eq('resolution', 'ROLLED_FORWARD'),
  ]);
  const outstandingRows = ((outstandingOrdersResult.data ?? []) as FinanceOrderRow[]).filter(
    (order) => paymentChannelIsCash(order.payment_channel_at_delivery),
  );
  const outstandingOrderIds = outstandingRows.map((order) => order.id);
  const allocationsResult =
    outstandingOrderIds.length > 0
      ? await supabase
          .from('settlement_allocation')
          .select('order_id, allocated_minor')
          .eq('merchant_account_id', merchantAccountId)
          .in('order_id', outstandingOrderIds)
      : { data: [], error: null };

  const kpis = kpisResult.data?.[0] ?? {
    a_encaisser: 0,
    ca_livre: 0,
    cash_chez_livreurs: 0,
    encaisse: 0,
    taux_refus: 0,
  };
  const aging = agingResult.data ?? [];
  const settingsRow = settingsResult.data as MerchantFeeSettings | null;
  const settings = settingsRow
    ? {
        cogs_known: settingsRow.cogs_known,
        default_delivery_cost_minor: settingsRow.default_delivery_cost_minor,
        free_money_fee_bps: settingsRow.free_money_fee_bps,
        merchant_levy_bps: settingsRow.merchant_levy_bps,
        orange_money_fee_bps: settingsRow.orange_money_fee_bps,
        transfer_tax_bps: settingsRow.transfer_tax_bps,
        transfer_tax_cap_minor: settingsRow.transfer_tax_cap_minor,
        wave_fee_bps: settingsRow.wave_fee_bps,
      }
    : defaultSettings;
  const settlementRows = (settlementsResult.data ?? []) as Array<{
    amount_received_minor: number;
    method: SettlementForMargin['method'];
  }>;
  const settlements = settlementRows.map((settlement) => ({
    amountReceivedMinor: settlement.amount_received_minor,
    method: settlement.method,
  }));
  const marginMinor = estimatedMarginMinor({
    caLivreMinor: kpis.ca_livre,
    deliveredOrdersCount: deliveredCountResult.count ?? 0,
    settlements,
    settings,
  });
  const driversConcerned = aging.filter((item) => item.outstanding_minor > 0).length;
  const allocatedByOrder = new Map<string, number>();

  for (const allocation of (allocationsResult.data ?? []) as AllocationRow[]) {
    allocatedByOrder.set(
      allocation.order_id,
      (allocatedByOrder.get(allocation.order_id) ?? 0) + allocation.allocated_minor,
    );
  }

  const driversById = new Map(
    ((driversResult.data ?? []) as DriverRow[]).map((driver) => [driver.id, driver]),
  );
  const agingByDriver = new Map(aging.map((item) => [item.driver_id, item]));
  const outstandingByDriver = new Map<string, FinanceDriverOutstanding>();

  for (const order of outstandingRows) {
    if (!order.assigned_driver_id) {
      continue;
    }

    const collectableMinor = cashCollectableMinor({
      cashCollectableMinor: order.cash_collectable_minor,
      paymentChannel: order.payment_channel_at_delivery,
      totalAmount: order.total_amount,
    });
    const outstandingMinor = Math.max(collectableMinor - (allocatedByOrder.get(order.id) ?? 0), 0);

    if (outstandingMinor <= 0) {
      continue;
    }

    const driver = driversById.get(order.assigned_driver_id);
    const agingRow = agingByDriver.get(order.assigned_driver_id);
    const current = outstandingByDriver.get(order.assigned_driver_id) ?? {
      aging: {
        bucket_1_3d: agingRow?.bucket_1_3d ?? 0,
        bucket_gt3d: agingRow?.bucket_gt3d ?? 0,
        bucket_lt1d: agingRow?.bucket_lt1d ?? 0,
      },
      driverId: order.assigned_driver_id,
      driverName: driver?.full_name ?? 'Livreur',
      driverPhone: driver?.phone ?? '',
      orders: [],
      outstandingMinor: 0,
    };

    current.orders.push({
      deliveredAt: order.updated_at ?? order.created_at,
      orderId: order.id,
      orderNumber: order.order_number,
      outstandingMinor,
    });
    current.outstandingMinor += outstandingMinor;
    outstandingByDriver.set(order.assigned_driver_id, current);
  }

  const driverOutstandings = [...outstandingByDriver.values()].sort(
    (left, right) => right.outstandingMinor - left.outstandingMinor,
  );
  const shortfallRows = (shortfallsResult.data ?? []) as ShortfallRow[];
  const shortfalls: FinanceShortfall[] = shortfallRows.map((shortfall) => ({
    driverId: shortfall.driver_id,
    driverName: driversById.get(shortfall.driver_id)?.full_name ?? 'Livreur',
    id: shortfall.id,
    reason: shortfall.reason,
    shortfallMinor: shortfall.shortfall_minor,
  }));
  const revenue = revenueResult.ok ? revenueResult.data.points : [];
  const codBreakdown = codBreakdownResult.ok ? codBreakdownResult.data : [];
  const shopPerformance = shopPerformanceResult.ok ? shopPerformanceResult.data : [];
  const hasFinancialData = kpis.ca_livre > 0 || kpis.encaisse > 0 || kpis.cash_chez_livreurs > 0;
  const periods = ['today', '7j', '30j'] as const;

  const [profitResult, expensesResult, categoriesResult] = await Promise.all([
    getFinanceReportAction({ from: from.toISOString(), to: to.toISOString() }),
    listExpensesAction({ from: toDateInput(from), to: toDateInput(to) }),
    listExpenseCategoriesAction({}),
  ]);

  const profitReport = profitResult?.data?.ok ? profitResult.data.report : null;
  const expenses = expensesResult?.data?.ok ? expensesResult.data.expenses : [];
  const categories = categoriesResult?.data?.ok ? categoriesResult.data.categories : [];

  return (
    <main className="space-y-6" id="main">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <h1 className="font-display text-4xl md:text-5xl">{t('title')}</h1>
          <p className="max-w-2xl text-muted">{t('subtitle')}</p>
        </div>
        <div className="flex flex-col items-stretch gap-3 md:items-end">
          <ReportDownloadButton
            errorLabel={t('report.error')}
            from={toDateInput(from)}
            label={t('report.download')}
            loadingLabel={t('report.loading')}
            to={toDateInput(to)}
          />
          <form className="flex flex-wrap items-end gap-2" method="get">
            <div className="flex rounded-lg border border-border bg-surface p-1 shadow-1">
              {periods.map((period) => (
                <Link
                  className={`grid min-h-11 place-items-center rounded-md px-3 text-sm font-medium ${
                    activePeriod === period ? 'bg-accent text-text' : 'text-muted hover:text-text'
                  }`}
                  href={`/finances?period=${period}`}
                  key={period}
                >
                  {t(`periods.${period}`)}
                </Link>
              ))}
            </div>
            <label className="space-y-1 text-xs font-medium text-muted">
              {t('periods.from')}
              <input
                className="block h-11 rounded-md border border-border bg-surface px-3 text-sm text-text"
                defaultValue={toDateInput(from)}
                name="from"
                type="date"
              />
            </label>
            <label className="space-y-1 text-xs font-medium text-muted">
              {t('periods.to')}
              <input
                className="block h-11 rounded-md border border-border bg-surface px-3 text-sm text-text"
                defaultValue={toDateInput(to)}
                name="to"
                type="date"
              />
            </label>
            <button
              className="min-h-11 rounded-md bg-accent px-4 text-sm font-semibold text-text hover:bg-accent-hover"
              type="submit"
            >
              {t('periods.custom')}
            </button>
          </form>
        </div>
      </header>

      <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-900 dark:border-amber-800/40 dark:bg-amber-950/30 dark:text-amber-200">
        <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <p className="text-xs">{t('disclaimer')}</p>
      </div>

      {profitReport ? (
        <ProfitSection from={toDateInput(from)} report={profitReport} to={toDateInput(to)} />
      ) : null}

      <ExpenseSection
        categories={categories}
        currentPeriodFrom={toDateInput(from)}
        currentPeriodTo={toDateInput(to)}
        expenses={expenses}
      />

      {!hasFinancialData ? (
        <section className="rounded-lg border border-border bg-surface p-5 text-muted shadow-1">
          {t('empty')}
        </section>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {kpiCard(t('kpis.caLivre'), formatMoney(kpis.ca_livre, 'XOF'))}
        {kpiCard(t('kpis.encaisse'), formatMoney(kpis.encaisse, 'XOF'))}
        {kpiCard(t('kpis.aEncaisser'), formatMoney(kpis.a_encaisser, 'XOF'))}
        {profitReport
          ? kpiCard(
              t('kpis.grossMargin'),
              formatMoney(profitReport.grossMarginMinor, 'XOF'),
              profitReport.cogsEstimated
                ? t('kpis.grossMarginDescEstimated')
                : t('kpis.grossMarginDescReal'),
            )
          : kpiCard(
              t('kpis.margin'),
              formatMoney(marginMinor, 'XOF'),
              settings.cogs_known ? undefined : t('kpis.marginEstimate'),
            )}
        {profitReport
          ? kpiCard(
              t('kpis.netProfit'),
              formatMoney(profitReport.netProfitMinor, 'XOF'),
              t('kpis.netProfitDesc'),
            )
          : null}
        {kpiCard(t('kpis.rto'), `${new Intl.NumberFormat('fr-FR').format(kpis.taux_refus)} %`)}
      </section>

      <Link
        className="group flex min-h-36 flex-col justify-between rounded-lg bg-accent p-5 text-text shadow-2 transition md:min-h-44 md:p-7"
        href="/finances#versements"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="flex items-center gap-2 text-sm font-semibold">
              <Wallet aria-hidden="true" className="size-5" />
              {t('kpis.cashDrivers')}
            </p>
            <p className="mt-4 font-display text-5xl italic md:text-6xl">
              {formatMoney(kpis.cash_chez_livreurs, 'XOF')}
            </p>
          </div>
          <ArrowRight
            aria-hidden="true"
            className="size-6 transition group-hover:translate-x-1 motion-reduce:transition-none"
          />
        </div>
        <p className="mt-4 text-sm font-medium">
          {t('kpis.driversConcerned', { count: driversConcerned })}
        </p>
      </Link>

      <DriverSettlementsLoader
        currentRole={role}
        drivers={driverOutstandings}
        shortfalls={shortfalls}
      />

      <FinanceChartsLoader
        aging={aging}
        agingTitle={t('charts.aging')}
        currency="XOF"
        emptyLabel={t('charts.empty')}
        funnel={codBreakdown.map((item) => ({
          count: item.count,
          label: t(`status.${item.status}`),
        }))}
        funnelTitle={t('charts.funnel')}
        revenue={revenue}
        revenueTitle={t('charts.revenue')}
        shops={shopPerformance.map((shop) => ({ name: shop.name, revenue: shop.revenue }))}
        shopsTitle={t('charts.shops')}
      />
    </main>
  );
}
