import { DriverSettlementsLoader } from '@/components/finance/DriverSettlementsLoader';
import { ExpenseSection } from '@/components/finance/ExpenseSection';
import { FinanceChartsLoader } from '@/components/finance/FinanceChartsLoader';
import { FinanceDriverCostView } from '@/components/finance/FinanceDriverCostView';
import { FinanceProductCostView } from '@/components/finance/FinanceProductCostView';
import { ProfitSection } from '@/components/finance/ProfitSection';
import { ReportDownloadButton } from '@/components/finance/ReportDownloadButton';
import { FinancePeriodPersistence } from '@/components/finance/finance-period-persistence';
import { FinanceTabSkeleton } from '@/components/finance/finance-tab-skeleton';
import { PeriodPicker } from '@/components/period-picker/period-picker';
import {
  MARGIN_PCT_MISSING_LABEL,
  missingInputLabel,
} from '@/components/purchases/purchase-lot-detail-panel';
import { ShopFilterPersistence } from '@/components/shops/shop-filter-persistence';
import { ShopFilterSelector } from '@/components/shops/shop-filter-selector';
import { Amount } from '@/components/ui/amount';
import { DefinitionCard } from '@/components/ui/definition-card';
import { GainLoss } from '@/components/ui/gain-loss';
import { ValueAmount } from '@/components/ui/value-state';
import { listExpenseCategoriesAction, listExpensesAction } from '@/lib/actions/expenses';
import { getFinanceChartsAction, getFinanceReportAction } from '@/lib/actions/profit';
import {
  type PurchaseLotData,
  getPurchaseLotPageData,
  getPurchaseLotProfitability,
} from '@/lib/actions/purchases';
import { fetchFinanceDriverCostReport } from '@/lib/finance/driver-cost';
import { buildDriverSettlements } from '@/lib/finance/driver-settlements';
import {
  type MerchantFeeSettings,
  type SettlementForMargin,
  estimatedMarginMinor,
} from '@/lib/finance/fees';
import type { PurchaseLotProfitabilitySummary } from '@/lib/finance/lot-profitability-assembly';
import { fetchFinanceProductCostReport } from '@/lib/finance/product-cost';
import { isProfitCoverageIncomplete } from '@/lib/finance/profit';
import { createFinanceAdminClient } from '@/lib/finance/report-data';
import { formatMoney } from '@/lib/format/fcfa';
import { formatPercentFr } from '@/lib/format/percent';
import type { ActivePeriod } from '@/lib/periods/date-range';
import { PERIOD_PRESETS, resolvePeriodRange, toDateInput } from '@/lib/periods/date-range';
import { listShopFilterOptions, normalizeShopParam } from '@/lib/shops/shop-filter';
import type { Database } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getRequestStoreId } from '@/lib/workspace/store';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AlertCircle, LockKeyhole, ReceiptText } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

type FinanceKpiRow = Database['public']['Functions']['finance_kpis']['Returns'][number];
type CashAgingRow = Database['public']['Functions']['cash_aging']['Returns'][number];

type FinanceTab = 'global' | 'produits' | 'livreurs' | 'arrivages';

type FinancesPageProps = {
  searchParams: Promise<{
    from?: string;
    period?: string;
    shop?: string;
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

function periodRange({
  from,
  period,
  to,
}: {
  from?: string;
  period?: string;
  to?: string;
}): { activePeriod: ActivePeriod; from: Date; to: Date } {
  return resolvePeriodRange({
    allowedPresets: PERIOD_PRESETS,
    defaultPreset: '30j',
    from,
    period,
    to,
  });
}

function normalizeFinanceTab(value: string | undefined): FinanceTab {
  return value === 'produits' || value === 'livreurs' || value === 'arrivages' ? value : 'global';
}

function buildFinanceHref(params: {
  from?: string;
  period?: string;
  shop?: string | null;
  storeId: string;
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
  if (params.shop) {
    search.set('shop', params.shop);
  }

  const query = search.toString();
  return query ? `/s/${params.storeId}/finances?${query}` : `/s/${params.storeId}/finances`;
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

function kpiCard(label: string, value: React.ReactNode, description?: React.ReactNode) {
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
    args: { p_from: string; p_merchant: string; p_shop_id?: string | null; p_to: string },
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
  shop,
  storeId,
  to,
}: {
  activeTab: FinanceTab;
  from: Date;
  period: string;
  shop: string;
  storeId: string;
  to: Date;
}) {
  const t = await getTranslations('finance');
  const periodParams = periodLinkParams(period, from, to);
  const tabClass = (active: boolean) =>
    `grid min-h-12 place-items-center rounded-md px-4 text-sm font-medium ${
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
        href={buildFinanceHref({ ...periodParams, shop, storeId, tab: 'global' })}
      >
        {t('tabs.global')}
      </Link>
      <Link
        aria-current={activeTab === 'produits' ? 'page' : undefined}
        className={tabClass(activeTab === 'produits')}
        href={buildFinanceHref({ ...periodParams, shop, storeId, tab: 'produits' })}
      >
        {t('tabs.products')}
      </Link>
      <Link
        aria-current={activeTab === 'livreurs' ? 'page' : undefined}
        className={tabClass(activeTab === 'livreurs')}
        href={buildFinanceHref({ ...periodParams, shop, storeId, tab: 'livreurs' })}
      >
        {t('tabs.drivers')}
      </Link>
      <Link
        aria-current={activeTab === 'arrivages' ? 'page' : undefined}
        className={tabClass(activeTab === 'arrivages')}
        href={buildFinanceHref({ ...periodParams, shop, storeId, tab: 'arrivages' })}
      >
        {t('tabs.arrivages')}
      </Link>
    </nav>
  );
}

async function GlobalTabContent({
  from,
  isShopFiltered,
  merchantAccountId,
  selectedShopId,
  storeId,
  supabase,
  to,
}: {
  from: Date;
  isShopFiltered: boolean;
  merchantAccountId: string;
  selectedShopId: string | null;
  storeId: string;
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  to: Date;
}) {
  const t = await getTranslations('finance');
  // 0117 : le nombre de livraisons vient de `finance_kpis` (meme CTE, meme fenetre que
  // `ca_livre`, bornee a l'etat COURANT `cod_status = 'LIVREE'` et groupee par commande).
  // Il remplace un count autonome sur `order_state_transition` qui, sans jointure vers
  // `orders`, comptait encore une commande invalidee et comptait DEUX fois une commande
  // livree -> invalidee -> re-livree (comptage de lignes de transition, pas de commandes).
  const [kpisResult, agingResult, settingsResult, settlementsResult] = await Promise.all([
    financeKpisRpc(supabase)('finance_kpis', {
      p_from: from.toISOString(),
      p_merchant: merchantAccountId,
      p_shop_id: selectedShopId,
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
  ]);

  const kpis = kpisResult.data?.[0] ?? {
    a_encaisser: 0,
    ca_livre: 0,
    cash_chez_livreurs: 0,
    delivered_orders_count: 0,
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
    deliveredOrdersCount: kpis.delivered_orders_count,
    settlements,
    settings,
  });
  const driversConcerned = aging.filter((item) => item.outstanding_minor > 0).length;

  const [profitResult, chartsResult, expensesResult, categoriesResult] = await Promise.all([
    getFinanceReportAction({
      from: from.toISOString(),
      shopId: selectedShopId,
      to: to.toISOString(),
    }),
    getFinanceChartsAction({
      from: from.toISOString(),
      shopId: selectedShopId,
      to: to.toISOString(),
    }),
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
      <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-900">
        <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <p className="text-xs">{t('disclaimer')}</p>
      </div>

      <p className="rounded-lg border border-border bg-surface p-3 text-xs text-muted shadow-1">
        {t('natureGlobal')}
      </p>

      {profitReport ? (
        <ProfitSection
          from={toDateInput(from)}
          report={profitReport}
          storeId={storeId}
          to={toDateInput(to)}
        />
      ) : null}

      <ExpenseSection
        categories={categories}
        currentPeriodFrom={toDateInput(from)}
        currentPeriodTo={toDateInput(to)}
        expenses={expenses}
        storeId={storeId}
      />

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {kpiCard(t('kpis.caUnified'), <Amount amountMinor={caMinor} className="font-mono" />)}
        {kpiCard(
          isShopFiltered ? t('kpis.cashDriversAllShops') : t('kpis.cashDrivers'),
          <Amount amountMinor={cashMinor} className="font-mono" />,
        )}
        {profitReport ? (
          isProfitCoverageIncomplete(profitReport) ? (
            <DefinitionCard
              definition={t('kpis.grossMarginDefinition')}
              description={t('profit.marginUnavailableHint')}
              formula={t('kpis.grossMarginFormula')}
              label={t('kpis.grossMargin')}
              value={t('profit.marginUnavailable')}
            />
          ) : (
            <DefinitionCard
              definition={t('kpis.grossMarginDefinition')}
              description={
                profitReport.cogsEstimated
                  ? t('kpis.grossMarginDescEstimated')
                  : t('kpis.grossMarginDescReal')
              }
              formula={t('kpis.grossMarginFormula')}
              label={t('kpis.grossMargin')}
              value={<Amount amountMinor={profitReport.grossMarginMinor} className="font-mono" />}
            />
          )
        ) : (
          <DefinitionCard
            definition={t('kpis.grossMarginDefinition')}
            description={settings.cogs_known ? undefined : t('kpis.marginEstimate')}
            formula={t('kpis.grossMarginFormula')}
            label={t('kpis.margin')}
            value={<Amount amountMinor={marginMinor} className="font-mono" />}
          />
        )}
        {profitReport ? (
          isProfitCoverageIncomplete(profitReport) ? (
            <DefinitionCard
              definition={t('kpis.netProfitDefinition')}
              description={t('profit.marginUnavailableHint')}
              formula={t('kpis.netProfitFormula')}
              label={t('kpis.netProfit')}
              value={t('profit.marginUnavailable')}
            />
          ) : (
            <DefinitionCard
              definition={t('kpis.netProfitDefinition')}
              description={t('kpis.netProfitDesc')}
              formula={t('kpis.netProfitFormula')}
              label={t('kpis.netProfit')}
              value={<Amount amountMinor={profitReport.netProfitMinor} className="font-mono" />}
            />
          )
        ) : null}
        <DefinitionCard
          definition={t('kpis.rtoDefinition')}
          formula={t('kpis.rtoFormula')}
          label={t('kpis.rto')}
          value={`${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(kpis.taux_refus)} %`}
        />
        {kpiCard(
          t('kpis.driversConcernedTitle'),
          new Intl.NumberFormat('fr-FR').format(driversConcerned),
          <Amount amountMinor={kpis.cash_chez_livreurs} />,
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
  isShopFiltered,
  merchantAccountId,
  selectedShopId,
  storeId,
  to,
}: {
  from: Date;
  isShopFiltered: boolean;
  merchantAccountId: string;
  selectedShopId: string | null;
  storeId: string;
  to: Date;
}) {
  const t = await getTranslations('finance');
  const admin = createFinanceAdminClient();
  const report = await fetchFinanceProductCostReport(
    admin,
    merchantAccountId,
    from.toISOString(),
    to.toISOString(),
    selectedShopId,
  );

  return (
    <FinanceProductCostView
      from={toDateInput(from)}
      report={report}
      storeId={storeId}
      scopeNote={isShopFiltered ? t('products.scopeNoteFiltered') : undefined}
      to={toDateInput(to)}
    />
  );
}

async function DriverTabContent({
  from,
  isShopFiltered,
  merchantAccountId,
  role,
  selectedShopId,
  supabase,
  to,
}: {
  from: Date;
  isShopFiltered: boolean;
  merchantAccountId: string;
  role: string;
  selectedShopId: string | null;
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  to: Date;
}) {
  const admin = createFinanceAdminClient();
  const t = await getTranslations('finance');
  const [report, settlements] = await Promise.all([
    fetchFinanceDriverCostReport(
      admin,
      merchantAccountId,
      from.toISOString(),
      to.toISOString(),
      selectedShopId,
    ),
    // Versements par livreur relocalisés ici (retirés de la Vue globale, §3.6).
    buildDriverSettlements(supabase as unknown as SupabaseClient<Database>, merchantAccountId),
  ]);

  return (
    <div className="space-y-5">
      <FinanceDriverCostView
        from={toDateInput(from)}
        report={report}
        scopeNote={isShopFiltered ? t('driverCost.scopeNoteFiltered') : undefined}
        to={toDateInput(to)}
      />
      <DriverSettlementsLoader
        currentRole={role}
        drivers={settlements.drivers}
        scopeNote={isShopFiltered ? t('kpis.cashDriversAllShops') : undefined}
        shortfalls={settlements.shortfalls}
      />
    </div>
  );
}

// ── Vue arrivages (Lot F2-bis) ───────────────────────────────────────────────
//
// Finances LISTE et AGRÈGE, Produits SAISIT et DÉTAILLE — aucun champ de
// saisie ici (ni transport, ni méthode de répartition, ni poids, ni dépense
// publicitaire) : cette carte renvoie vers la Fiche arrivage sous Produits
// pour tout geste. Réutilise exclusivement les composants livrés en U1-F/F2
// (`GainLoss`, `ValueAmount`) — aucun nouveau composant financier.
function ArrivageCard({
  lot,
  profitability,
  storeId,
}: {
  lot: PurchaseLotData;
  profitability: PurchaseLotProfitabilitySummary;
  storeId: string;
}) {
  const detailHref = `/s/${storeId}/produits?tab=achats&lot=${lot.id}`;

  if (!profitability.ok) {
    return (
      <article className="rounded-lg border border-border bg-surface p-4 shadow-1">
        <div className="flex items-start justify-between gap-3">
          <p className="font-medium text-text">{lot.supplierName}</p>
          <Link className="text-sm font-medium text-accent underline" href={detailHref}>
            Voir la fiche
          </Link>
        </div>
        <p className="mt-2 text-sm text-muted">
          {profitability.reason === 'not_found'
            ? 'Arrivage introuvable.'
            : 'Rentabilité indisponible pour le moment.'}
        </p>
      </article>
    );
  }

  if (!profitability.allocationMethodAvailable) {
    return (
      <article className="rounded-lg border border-border bg-surface p-4 shadow-1">
        <div className="flex items-start justify-between gap-3">
          <p className="font-medium text-text">{lot.supplierName}</p>
          <Link className="text-sm font-medium text-accent underline" href={detailHref}>
            Voir la fiche
          </Link>
        </div>
        <p className="mt-2 text-sm text-warning">
          Répartition au poids indisponible : au moins une ligne n'a pas de poids renseigné.
        </p>
      </article>
    );
  }

  const { totals } = profitability;
  const marginPctMissing = totals.cashCollectedMinor === 0;

  return (
    <article className="space-y-3 rounded-lg border border-border bg-surface p-4 shadow-1">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium text-text">{lot.supplierName}</p>
          <p className="text-xs text-muted">
            Reçu le {lot.receivedAt ?? lot.orderedAt}
            {lot.reference ? ` · ${lot.reference}` : ''}
          </p>
        </div>
        <Link className="text-sm font-medium text-accent underline" href={detailHref}>
          Voir la fiche
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <GainLoss
          amountMinor={totals.marginMinor}
          labels={{ gain: 'Marge', loss: 'Marge', neutral: 'Marge nulle' }}
        />
        {marginPctMissing ? (
          <ValueAmount state={{ kind: 'missing', label: MARGIN_PCT_MISSING_LABEL }} />
        ) : (
          <span className="text-sm text-muted">{formatPercentFr(totals.marginPct)} %</span>
        )}
        <span className="text-sm text-muted">
          {totals.qtySold} / {totals.qtyReceived} vendus
        </span>
      </div>

      {!totals.complete && (
        <p className="text-xs text-warning">
          Marge provisoire — en attente de :{' '}
          {totals.missingInputs.map(missingInputLabel).join(', ')}.
        </p>
      )}
    </article>
  );
}

async function ArrivagesTabContent({ storeId }: { storeId: string }) {
  const t = await getTranslations('finance');
  const purchaseResult = await getPurchaseLotPageData(storeId);

  if (!purchaseResult.ok) {
    return (
      <div className="rounded-lg border border-danger/30 bg-surface p-6 text-sm text-danger shadow-1">
        {purchaseResult.message}
      </div>
    );
  }

  // Rentabilité chargée uniquement pour les lots REÇUS (même garde que la page
  // Produits) : un lot pas encore reçu n'a ni CA encaissé ni coût de revient
  // figé, rien d'utile à agréger avant réception.
  const receivedLots = purchaseResult.lots.filter((lot) => lot.status === 'received');
  const profitabilityEntries = await Promise.all(
    receivedLots.map(async (lot) => [lot.id, await getPurchaseLotProfitability(lot.id)] as const),
  );
  const profitabilityByLotId = Object.fromEntries(profitabilityEntries);

  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-border bg-surface p-3 text-xs text-muted shadow-1">
        {t('natureArrivages')}
      </p>

      {receivedLots.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface p-6 text-sm text-muted-foreground shadow-1">
          {t('arrivages.empty')}
        </p>
      ) : (
        receivedLots.map((lot) => (
          <ArrivageCard
            key={lot.id}
            lot={lot}
            profitability={profitabilityByLotId[lot.id]}
            storeId={storeId}
          />
        ))
      )}
    </div>
  );
}

export default async function FinancesPage({ searchParams }: FinancesPageProps) {
  const nav = await getTranslations('nav');
  const t = await getTranslations('finance');
  const params = await searchParams;
  const storeId = await getRequestStoreId();
  if (!storeId) {
    redirect('/s');
  }
  const { activePeriod, from, to } = periodRange(params);
  const activeTab = normalizeFinanceTab(params.tab);
  const { merchantAccountId, role, supabase } = await getCurrentMember();
  const shops = merchantAccountId ? await listShopFilterOptions(supabase, merchantAccountId) : [];
  const selectedShopId = normalizeShopParam(params.shop, shops);
  const activeShopParam = selectedShopId ?? 'all';

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
        <FinancePeriodPersistence activeTab={activeTab} storeId={storeId} />
      </Suspense>
      <Suspense fallback={null}>
        <ShopFilterPersistence storageKey="teer.finances.shop" />
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
              shopId={selectedShopId}
              to={toDateInput(to)}
            />
          ) : null}
          {/* Boutique/période : sans effet sur la vue arrivages (toujours la
              boutique active, pas de fenêtre temporelle — un arrivage reçu
              reste dans la liste jusqu'à épuisement de son stock, pas jusqu'à
              la fin d'une période). Masqués plutôt que visibles-mais-inertes. */}
          {activeTab !== 'arrivages' ? (
            <>
              <ShopFilterSelector
                allLabel={t('shops.all')}
                ariaLabel={t('shops.ariaLabel')}
                label={t('shops.label')}
                pathname={`/s/${storeId}/finances`}
                searchParams={{
                  from: params.from,
                  period: params.period,
                  shop: params.shop,
                  tab: params.tab,
                  to: params.to,
                }}
                selectedShopId={selectedShopId}
                shops={shops}
              />
              <PeriodPicker />
            </>
          ) : null}
        </div>
      </header>

      {
        await FinanceTabBar({
          activeTab,
          from,
          period: activePeriod,
          shop: activeShopParam,
          storeId,
          to,
        })
      }

      <Suspense fallback={<FinanceTabSkeleton />} key={`${activeTab}-${activePeriod}`}>
        {activeTab === 'global' ? (
          <GlobalTabContent
            from={from}
            isShopFiltered={selectedShopId !== null}
            merchantAccountId={merchantAccountId}
            selectedShopId={selectedShopId}
            storeId={storeId}
            supabase={supabase}
            to={to}
          />
        ) : activeTab === 'produits' ? (
          <ProductTabContent
            from={from}
            isShopFiltered={selectedShopId !== null}
            merchantAccountId={merchantAccountId}
            selectedShopId={selectedShopId}
            storeId={storeId}
            to={to}
          />
        ) : activeTab === 'livreurs' ? (
          <DriverTabContent
            from={from}
            isShopFiltered={selectedShopId !== null}
            merchantAccountId={merchantAccountId}
            role={role}
            selectedShopId={selectedShopId}
            supabase={supabase}
            to={to}
          />
        ) : (
          <ArrivagesTabContent storeId={storeId} />
        )}
      </Suspense>
    </main>
  );
}
