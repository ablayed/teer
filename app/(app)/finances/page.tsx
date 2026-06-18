import { DriverSettlementsLoader } from '@/components/finance/DriverSettlementsLoader';
import { ExpenseSection } from '@/components/finance/ExpenseSection';
import { FinanceChartsLoader } from '@/components/finance/FinanceChartsLoader';
import { FinanceDriverCostView } from '@/components/finance/FinanceDriverCostView';
import { FinanceProductCostView } from '@/components/finance/FinanceProductCostView';
import { ProfitSection } from '@/components/finance/ProfitSection';
import { ReportDownloadButton } from '@/components/finance/ReportDownloadButton';
import { FinancePeriodPersistence } from '@/components/finance/finance-period-persistence';
import { FinanceTabSkeleton } from '@/components/finance/finance-tab-skeleton';
import { DefinitionCard } from '@/components/ui/definition-card';
import { listExpenseCategoriesAction, listExpensesAction } from '@/lib/actions/expenses';
import { getFinanceChartsAction, getFinanceReportAction } from '@/lib/actions/profit';
import { fetchFinanceDriverCostReport } from '@/lib/finance/driver-cost';
import { buildDriverSettlements } from '@/lib/finance/driver-settlements';
import {
  type MerchantFeeSettings,
  type SettlementForMargin,
  estimatedMarginMinor,
} from '@/lib/finance/fees';
import { fetchFinanceProductCostReport } from '@/lib/finance/product-cost';
import { createFinanceAdminClient } from '@/lib/finance/report-data';
import { formatMoney } from '@/lib/format/fcfa';
import type { Database } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AlertCircle, LockKeyhole, ReceiptText } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { Suspense } from 'react';

type FinanceKpiRow = Database['public']['Functions']['finance_kpis']['Returns'][number];
type CashAgingRow = Database['public']['Functions']['cash_aging']['Returns'][number];

type FinanceTab = 'global' | 'produits' | 'livreurs';

type FinancesPageProps = {
  searchParams: Promise<{
    from?: string;
    period?: string;
    tab?: string;
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

  const days = period === '7j' ? 7 : period === '90j' ? 90 : 30;
  const start = startOfDay(now);
  start.setDate(start.getDate() - (days - 1));
  const activePeriod = days === 7 ? '7j' : days === 90 ? '90j' : '30j';

  return { activePeriod, from: start, to: end };
}

function toDateInput(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function normalizeFinanceTab(value: string | undefined): FinanceTab {
  return value === 'produits' || value === 'livreurs' ? value : 'global';
}

function buildFinanceHref(params: {
  from?: string;
  period?: string;
  tab: FinanceTab;
  to?: string;
}): string {
  const search = new URLSearchParams();
  search.set('tab', params.tab);
  if (params.period) {
    search.set('period', params.period);
  }
  if (params.from) {
    search.set('from', params.from);
  }
  if (params.to) {
    search.set('to', params.to);
  }

  const query = search.toString();
  return query ? `/finances?${query}` : '/finances';
}

// Paramètres de période à transporter d'un lien à l'autre (changement d'onglet) :
// un preset ne porte QUE `period` (sinon `from`/`to` gagnent dans `periodRange` et
// le clic du preset est ignoré — bug §4) ; seul « Personnalisé » porte `from`/`to`.
function periodLinkParams(
  activePeriod: string,
  from: Date,
  to: Date,
): { from?: string; period?: string; to?: string } {
  if (activePeriod === 'custom') {
    return { from: toDateInput(from), to: toDateInput(to) };
  }
  return { period: activePeriod };
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

async function FinanceTabBar({
  activeTab,
  from,
  period,
  to,
}: {
  activeTab: FinanceTab;
  from: Date;
  period: string;
  to: Date;
}) {
  const t = await getTranslations('finance');
  const periodParams = periodLinkParams(period, from, to);
  const tabClass = (active: boolean) =>
    `grid min-h-11 place-items-center rounded-md px-4 text-sm font-medium ${
      active ? 'bg-accent text-text' : 'text-muted hover:text-text'
    }`;

  return (
    <nav
      aria-label={t('tabs.ariaLabel')}
      className="flex flex-wrap gap-2 rounded-lg border border-border bg-surface p-1 shadow-1"
    >
      <Link
        aria-current={activeTab === 'global' ? 'page' : undefined}
        className={tabClass(activeTab === 'global')}
        href={buildFinanceHref({ ...periodParams, tab: 'global' })}
      >
        {t('tabs.global')}
      </Link>
      <Link
        aria-current={activeTab === 'produits' ? 'page' : undefined}
        className={tabClass(activeTab === 'produits')}
        href={buildFinanceHref({ ...periodParams, tab: 'produits' })}
      >
        {t('tabs.products')}
      </Link>
      <Link
        aria-current={activeTab === 'livreurs' ? 'page' : undefined}
        className={tabClass(activeTab === 'livreurs')}
        href={buildFinanceHref({ ...periodParams, tab: 'livreurs' })}
      >
        {t('tabs.drivers')}
      </Link>
    </nav>
  );
}

async function PeriodControls({
  activeTab,
  activePeriod,
  from,
  to,
}: {
  activeTab: FinanceTab;
  activePeriod: string;
  from: Date;
  to: Date;
}) {
  const t = await getTranslations('finance');
  const periods = ['today', '7j', '30j', '90j'] as const;

  return (
    <form className="flex flex-wrap items-end gap-2" method="get">
      <input name="tab" type="hidden" value={activeTab} />
      <div className="flex rounded-lg border border-border bg-surface p-1 shadow-1">
        {periods.map((period) => (
          <Link
            aria-current={activePeriod === period ? 'true' : undefined}
            className={`grid min-h-11 place-items-center rounded-md px-3 text-sm font-medium ${
              activePeriod === period ? 'bg-accent text-text' : 'text-muted hover:text-text'
            }`}
            // Preset = `period` seul (pas de from/to), sinon le clic est ignoré (§4).
            href={buildFinanceHref({ period, tab: activeTab })}
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
        {t('periods.apply')}
      </button>
    </form>
  );
}

async function GlobalTabContent({
  from,
  merchantAccountId,
  supabase,
  to,
}: {
  from: Date;
  merchantAccountId: string;
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  to: Date;
}) {
  const t = await getTranslations('finance');
  const [kpisResult, agingResult, settingsResult, settlementsResult, deliveredCountResult] =
    await Promise.all([
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
    ]);

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

  const [profitResult, chartsResult, expensesResult, categoriesResult] = await Promise.all([
    getFinanceReportAction({ from: from.toISOString(), to: to.toISOString() }),
    getFinanceChartsAction({ from: from.toISOString(), to: to.toISOString() }),
    listExpensesAction({ from: toDateInput(from), to: toDateInput(to) }),
    listExpenseCategoriesAction({}),
  ]);

  const profitReport = profitResult?.data?.ok ? profitResult.data.report : null;
  const charts = chartsResult?.data?.ok ? chartsResult.data.charts : null;
  const revenue = charts?.revenue ?? [];
  const codFunnel = charts?.funnel ?? [];
  const shopPerformance = charts?.shops ?? [];
  const expenses = expensesResult?.data?.ok ? expensesResult.data.expenses : [];
  const categories = categoriesResult?.data?.ok ? categoriesResult.data.categories : [];
  const caMinor = profitReport?.netCAMinor ?? kpis.ca_livre;
  const cashMinor = kpis.cash_chez_livreurs;

  return (
    <>
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

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {kpiCard(t('kpis.caUnified'), formatMoney(caMinor, 'XOF'))}
        {kpiCard(t('kpis.cashDrivers'), formatMoney(cashMinor, 'XOF'))}
        {profitReport ? (
          <DefinitionCard
            definition={t('kpis.grossMarginDefinition')}
            description={
              profitReport.cogsEstimated
                ? t('kpis.grossMarginDescEstimated')
                : t('kpis.grossMarginDescReal')
            }
            formula={t('kpis.grossMarginFormula')}
            label={t('kpis.grossMargin')}
            value={formatMoney(profitReport.grossMarginMinor, 'XOF')}
          />
        ) : (
          <DefinitionCard
            definition={t('kpis.grossMarginDefinition')}
            description={settings.cogs_known ? undefined : t('kpis.marginEstimate')}
            formula={t('kpis.grossMarginFormula')}
            label={t('kpis.margin')}
            value={formatMoney(marginMinor, 'XOF')}
          />
        )}
        {profitReport ? (
          <DefinitionCard
            definition={t('kpis.netProfitDefinition')}
            description={t('kpis.netProfitDesc')}
            formula={t('kpis.netProfitFormula')}
            label={t('kpis.netProfit')}
            value={formatMoney(profitReport.netProfitMinor, 'XOF')}
          />
        ) : null}
        <DefinitionCard
          definition={t('kpis.rtoDefinition')}
          formula={t('kpis.rtoFormula')}
          label={t('kpis.rto')}
          value={`${new Intl.NumberFormat('fr-FR').format(kpis.taux_refus)} %`}
        />
        {kpiCard(
          t('kpis.driversConcernedTitle'),
          new Intl.NumberFormat('fr-FR').format(driversConcerned),
          formatMoney(kpis.cash_chez_livreurs, 'XOF'),
        )}
      </section>

      <Link
        className="group flex min-h-36 flex-col justify-between rounded-lg bg-accent p-5 text-text shadow-2 transition md:min-h-44 md:p-7"
        href="/livreurs"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="flex items-center gap-2 text-sm font-semibold">
              <ReceiptText aria-hidden="true" className="size-5" />
              {t('kpis.cashDriversGlobal')}
            </p>
            <p className="mt-4 font-display text-5xl italic md:text-6xl">
              {formatMoney(kpis.cash_chez_livreurs, 'XOF')}
            </p>
          </div>
        </div>
        <p className="mt-4 text-sm font-medium">
          {t('kpis.driversConcerned', {
            count: driversConcerned,
          })}
        </p>
      </Link>

      <FinanceChartsLoader
        aging={aging}
        agingTitle={t('charts.aging')}
        currency="XOF"
        emptyLabel={t('charts.empty')}
        funnel={codFunnel.map((item) => ({
          count: item.count,
          label: t(`status.${item.status}`),
        }))}
        funnelTitle={t('charts.funnel')}
        revenue={revenue}
        revenueTitle={t('charts.revenue')}
        shops={shopPerformance}
        shopsTitle={t('charts.shops')}
      />
    </>
  );
}

async function ProductTabContent({
  from,
  merchantAccountId,
  to,
}: {
  from: Date;
  merchantAccountId: string;
  to: Date;
}) {
  const admin = createFinanceAdminClient();
  const report = await fetchFinanceProductCostReport(
    admin,
    merchantAccountId,
    from.toISOString(),
    to.toISOString(),
  );

  return <FinanceProductCostView from={toDateInput(from)} report={report} to={toDateInput(to)} />;
}

async function DriverTabContent({
  from,
  merchantAccountId,
  role,
  supabase,
  to,
}: {
  from: Date;
  merchantAccountId: string;
  role: string;
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  to: Date;
}) {
  const admin = createFinanceAdminClient();
  const [report, settlements] = await Promise.all([
    fetchFinanceDriverCostReport(admin, merchantAccountId, from.toISOString(), to.toISOString()),
    // Versements par livreur relocalisés ici (retirés de la Vue globale, §3.6).
    buildDriverSettlements(supabase as unknown as SupabaseClient<Database>, merchantAccountId),
  ]);

  return (
    <div className="space-y-5">
      <FinanceDriverCostView from={toDateInput(from)} report={report} to={toDateInput(to)} />
      <DriverSettlementsLoader
        currentRole={role}
        drivers={settlements.drivers}
        shortfalls={settlements.shortfalls}
      />
    </div>
  );
}

export default async function FinancesPage({ searchParams }: FinancesPageProps) {
  const nav = await getTranslations('nav');
  const t = await getTranslations('finance');
  const params = await searchParams;
  const { activePeriod, from, to } = periodRange(params);
  const activeTab = normalizeFinanceTab(params.tab);
  const { merchantAccountId, role, supabase } = await getCurrentMember();

  if (!merchantAccountId || role !== 'owner') {
    return (
      <main className="space-y-6" id="main">
        <header className="space-y-2">
          <h1 className="font-display text-4xl md:text-5xl">{nav('finances')}</h1>
        </header>
        <section className="flex max-w-2xl gap-3 rounded-lg border border-border bg-surface p-5 text-muted shadow-1">
          <LockKeyhole aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <p>{t('restricted')}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="space-y-6" id="main">
      <Suspense fallback={null}>
        <FinancePeriodPersistence activeTab={activeTab} />
      </Suspense>
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <h1 className="font-display text-4xl md:text-5xl">{nav('finances')}</h1>
          <p className="max-w-2xl text-muted">{t('subtitle')}</p>
        </div>
        <div className="flex flex-col items-stretch gap-3 md:items-end">
          {activeTab === 'global' ? (
            <ReportDownloadButton
              errorLabel={t('report.error')}
              from={toDateInput(from)}
              label={t('report.download')}
              loadingLabel={t('report.loading')}
              to={toDateInput(to)}
            />
          ) : null}
          {await PeriodControls({ activePeriod, activeTab, from, to })}
        </div>
      </header>

      {await FinanceTabBar({ activeTab, from, period: activePeriod, to })}

      <Suspense fallback={<FinanceTabSkeleton />} key={`${activeTab}-${activePeriod}`}>
        {activeTab === 'global' ? (
          <GlobalTabContent
            from={from}
            merchantAccountId={merchantAccountId}
            supabase={supabase}
            to={to}
          />
        ) : activeTab === 'produits' ? (
          <ProductTabContent from={from} merchantAccountId={merchantAccountId} to={to} />
        ) : (
          <DriverTabContent
            from={from}
            merchantAccountId={merchantAccountId}
            role={role}
            supabase={supabase}
            to={to}
          />
        )}
      </Suspense>
    </main>
  );
}
