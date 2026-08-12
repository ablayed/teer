import { CODStatusBreakdown } from '@/components/dashboard/CODStatusBreakdown';
import { DashboardMotion } from '@/components/dashboard/DashboardMotion';
import { OrderExceptionsGrid } from '@/components/dashboard/OrderExceptionsGrid';
import { RecentActivity } from '@/components/dashboard/RecentActivity';
import { RevenueChart } from '@/components/dashboard/RevenueChart';
import { ShopPerformance } from '@/components/dashboard/ShopPerformance';
import { TopProducts } from '@/components/dashboard/TopProducts';
import { DeliveryRateTrend } from '@/components/dashboard/delivery-rate-trend';
import { TableauCashByProductChart } from '@/components/dashboard/tableau-period-metrics';
import { TableauPeriodPersistence } from '@/components/dashboard/tableau-period-persistence';
import { DashboardKpiRefresh } from '@/components/kpi/dashboard-kpi-refresh';
import { ActivationChecklist } from '@/components/onboarding/activation-checklist';
import { PeriodPicker } from '@/components/period-picker/period-picker';
import { ShopFilterPersistence } from '@/components/shops/shop-filter-persistence';
import { ShopFilterSelector } from '@/components/shops/shop-filter-selector';
import { Card } from '@/components/ui/card';
import { DefinitionToggle } from '@/components/ui/definition-card';
import {
  getCodBreakdown,
  getDashboardCashCollectedByProduct,
  getDashboardCashCollectedTotal,
  getDashboardDeliveriesByProduct,
  getDashboardKpi,
  getPriorityCounts,
  getRecentActivity,
  getRevenue30d,
  getShopPerformance,
  getTopProducts,
} from '@/lib/actions/dashboard';
import { getDriversCashOnHandTotal } from '@/lib/actions/drivers';
import { getLossAnalyticsAction } from '@/lib/actions/loss-analytics';
import { getCachedDashboardContext } from '@/lib/dashboard/context';
import {
  type MetricLoadState,
  type ReadonlyMetricResult,
  toMetricLoadState,
} from '@/lib/dashboard/metric-load-state';
import { buildOrderViewHref } from '@/lib/domain/order-saved-views';
import { formatMoney } from '@/lib/format/fcfa';
import type { LossAnalyticsTrendPoint } from '@/lib/loss-analytics/metrics';
import { PERIOD_PRESETS, resolvePeriodRange } from '@/lib/periods/date-range';
import { cn } from '@/lib/utils';
import { getRequestStoreId } from '@/lib/workspace/store';
import * as Sentry from '@sentry/nextjs';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { Suspense, cache } from 'react';

type TableauPageProps = {
  searchParams: Promise<{
    from?: string;
    period?: string;
    shop?: string;
    to?: string;
    welcome?: string;
    role?: string;
  }>;
};

const welcomeRoles = ['owner', 'manager', 'agent'] as const;

function firstToken(value: string | null | undefined): string {
  return value?.trim().split(/\s+/)[0] ?? '';
}

function displayNameFromMetadata(metadata: Record<string, unknown>): string {
  const name = metadata.full_name ?? metadata.name;

  return typeof name === 'string' ? firstToken(name) : '';
}

// Dedup le fetch KPI partage entre le sous-titre, la bande KPI et les blocs
// qui s'en servent pour la devise (revenue / top produits / boutiques).
const loadDashboardKpi = cache(getDashboardKpi);

async function CallQueueSubtitle({ shopId }: { shopId: string | null }) {
  const [t, kpiResult] = await Promise.all([getTranslations('tableau'), loadDashboardKpi(shopId)]);
  const callQueueCount = kpiResult.ok ? kpiResult.data.a_appeler_count : 0;

  return <p className="text-muted">{t('subtitle', { count: callQueueCount })}</p>;
}

async function KpiStrip({ shopId }: { shopId: string | null }) {
  const kpiResult = await loadDashboardKpi(shopId);
  const kpi = kpiResult.ok ? kpiResult.data : null;

  return (
    <DashboardKpiRefresh
      initialKpi={kpi}
      initialUpdatedAt={new Date().toISOString()}
      shopId={shopId}
    />
  );
}

// Priorités à traiter : chaque ligne borne sa fenêtre à 7 jours sur le même champ que sa
// liste-cible /commandes?vue=<id>&period=7j&shop=<actif> (cf. getPriorityCounts) — compteur
// dashboard = nombre affiché au clic, pas juste un `period=7j` cosmétique dans l'URL.
async function ExceptionsSection({ shopId }: { shopId: string | null }) {
  const [t, countsResult] = await Promise.all([
    getTranslations('tableau.blocks.exceptions'),
    getPriorityCounts(shopId),
  ]);
  const counts = countsResult.ok
    ? countsResult.data
    : { aAppeler: 0, aRappeler: 0, annuleesRetours: 0, enLivraison: 0 };
  const hrefFor = (viewId: Parameters<typeof buildOrderViewHref>[0]) =>
    buildOrderViewHref(viewId, { period: '7j', shopId });

  const exceptionCards = [
    {
      title: t('groups.urgences'),
      rows: [
        {
          count: counts.aAppeler,
          href: hrefFor('a-appeler'),
          label: t('rows.aAppeler'),
        },
        {
          count: counts.aRappeler,
          href: buildOrderViewHref('tentee-a-rappeler', { shopId }),
          label: t('rows.aRappeler'),
        },
      ],
    },
    {
      title: t('groups.livraison'),
      rows: [
        {
          count: counts.enLivraison,
          href: hrefFor('en-livraison'),
          label: t('rows.enLivraison'),
        },
      ],
    },
    // Note : la carte « Trésorerie / Cash à remettre » est retirée de l'Aperçu Commandes.
    // Le cash se gère désormais dans Finances / Livreurs (hors périmètre Commandes).
    {
      title: t('groups.annulations'),
      rows: [
        {
          count: counts.annuleesRetours,
          href: hrefFor('annulees-retours'),
          label: t('rows.annuleesRetours'),
        },
      ],
    },
  ];

  return <OrderExceptionsGrid cards={exceptionCards} title={t('title')} />;
}

function isCashCollectedEmpty(data: { caMinor: number }): boolean {
  return data.caMinor <= 0;
}

function isCashByProductEmpty(data: { items: { revenueMinor: number }[]; totalMinor: number }) {
  return data.totalMinor <= 0 || !data.items.some((item) => item.revenueMinor > 0);
}

function isDeliveriesEmpty(data: { totalDeliveries: number }): boolean {
  return data.totalDeliveries <= 0;
}

type DeliveryRateTrendData = {
  trends: LossAnalyticsTrendPoint[];
};

function isDeliveryRateTrendEmpty(data: DeliveryRateTrendData): boolean {
  return data.trends.every((point) => point.totalOrders === 0);
}

function logMetricLoadError(metric: string, state: MetricLoadState<unknown>) {
  if (state.status !== 'error') {
    return;
  }

  Sentry.captureMessage('Tableau metric load failed', {
    extra: { errorCode: state.errorCode },
    level: 'error',
    tags: {
      metric,
      page: 'tableau',
    },
  });
}

function EssentialMetricCard({
  definition,
  errorLabel,
  hint,
  label,
  stateLabel,
  stateTone = 'neutral',
  value,
}: {
  definition?: string;
  errorLabel?: string;
  hint?: string;
  label: string;
  stateLabel?: string;
  stateTone?: 'danger' | 'neutral';
  value?: string;
}) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4 shadow-1">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] font-medium text-muted">{label}</p>
        {definition ? <DefinitionToggle definition={definition} /> : null}
      </div>
      {value ? (
        <p className="mt-2 font-mono text-2xl font-semibold tabular-nums">{value}</p>
      ) : (
        <p
          className={cn(
            'mt-3 rounded-md border border-dashed p-3 text-sm font-medium',
            stateTone === 'danger'
              ? 'border-danger/20 bg-danger-subtle text-danger'
              : 'border-border bg-canvas text-muted',
          )}
        >
          {stateLabel ?? errorLabel}
        </p>
      )}
      {hint && value ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </section>
  );
}

// Essentiels opérations reste masqué en bloc à l'agent. Les nouvelles métriques CA/livraisons
// héritent de ce RBAC et ne déclenchent aucun appel financier pour ce rôle.
async function OperationsEssentialsSection({
  period,
  shopId,
}: {
  period: TableauPeriodRange;
  shopId: string | null;
}) {
  const ctx = await getCachedDashboardContext();
  if (!ctx.ok) return null;
  if (ctx.role !== 'owner' && ctx.role !== 'manager') return null;

  const [tOps, tPeriodMetrics, cashTotal, lossResult, cashCollectedResult, deliveriesResult] =
    await Promise.all([
      getTranslations('tableau.blocks.operationsEssentials'),
      getTranslations('tableau.blocks.periodMetrics'),
      getDriversCashOnHandTotal(shopId),
      getLossAnalyticsAction({
        from: period.from.toISOString(),
        shopId,
        to: period.to.toISOString(),
      }),
      getDashboardCashCollectedTotal({ from: period.from, shopId, to: period.to }),
      getDashboardDeliveriesByProduct({ from: period.from, shopId, to: period.to }),
    ]);

  const cashCollectedState = toMetricLoadState(cashCollectedResult, isCashCollectedEmpty);
  const deliveriesState = toMetricLoadState(deliveriesResult, isDeliveriesEmpty);
  logMetricLoadError('cash_collected_total', cashCollectedState);
  logMetricLoadError('deliveries_total', deliveriesState);
  const loss = lossResult?.data?.ok ? lossResult.data.analytics.summary : null;
  const hasCashTotalError = !cashTotal.ok;
  const hasLossError = !loss;
  const pct = (ratio: number) =>
    new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1, style: 'percent' }).format(ratio);
  const deliveryRate =
    loss && loss.rtoDenominator > 0 ? loss.deliveredCount / loss.rtoDenominator : 0;

  const cashHint = cashTotal.ok
    ? tOps('cashDrivers.hint', { count: cashTotal.driverCount })
    : undefined;

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">{tOps('title')}</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <EssentialMetricCard
          definition={tOps('cashCollected.definition')}
          hint={cashCollectedState.status === 'ready' ? tOps('periodHint') : undefined}
          label={tOps('cashCollected.label')}
          stateLabel={
            cashCollectedState.status === 'error'
              ? tPeriodMetrics('error')
              : tPeriodMetrics('empty')
          }
          stateTone={cashCollectedState.status === 'error' ? 'danger' : 'neutral'}
          value={
            cashCollectedState.status === 'ready'
              ? formatMoney(cashCollectedState.data.caMinor)
              : undefined
          }
        />
        <EssentialMetricCard
          hint={deliveriesState.status === 'ready' ? tOps('periodHint') : undefined}
          label={tOps('deliveries.label')}
          stateLabel={
            deliveriesState.status === 'error' ? tPeriodMetrics('error') : tPeriodMetrics('empty')
          }
          stateTone={deliveriesState.status === 'error' ? 'danger' : 'neutral'}
          value={
            deliveriesState.status === 'ready'
              ? new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(
                  deliveriesState.data.totalDeliveries,
                )
              : undefined
          }
        />
        <EssentialMetricCard
          hint={cashHint}
          label={tOps('cashDrivers.label')}
          stateLabel={hasCashTotalError ? tPeriodMetrics('error') : undefined}
          stateTone={hasCashTotalError ? 'danger' : 'neutral'}
          value={cashTotal.ok ? formatMoney(cashTotal.totalMinor, 'XOF') : undefined}
        />
        <EssentialMetricCard
          label={tOps('cancellationRate')}
          stateLabel={hasLossError ? tPeriodMetrics('error') : undefined}
          stateTone={hasLossError ? 'danger' : 'neutral'}
          value={loss ? pct(loss.cancellationRate) : undefined}
        />
        <EssentialMetricCard
          label={tOps('deliveryRate')}
          stateLabel={hasLossError ? tPeriodMetrics('error') : undefined}
          stateTone={hasLossError ? 'danger' : 'neutral'}
          value={loss ? pct(deliveryRate) : undefined}
        />
        <EssentialMetricCard
          label={tOps('returnRate')}
          stateLabel={hasLossError ? tPeriodMetrics('error') : undefined}
          stateTone={hasLossError ? 'danger' : 'neutral'}
          value={loss ? pct(loss.returnRate) : undefined}
        />
      </div>
    </section>
  );
}

async function DeliveryRateTrendSection({
  period,
  shopId,
}: {
  period: TableauPeriodRange;
  shopId: string | null;
}) {
  const ctx = await getCachedDashboardContext();
  if (!ctx.ok || (ctx.role !== 'owner' && ctx.role !== 'manager')) {
    return null;
  }

  const [t, lossResult] = await Promise.all([
    getTranslations('tableau.blocks.deliveryRateTrend'),
    getLossAnalyticsAction({
      from: period.from.toISOString(),
      shopId,
      to: period.to.toISOString(),
    }),
  ]);
  const lossData = lossResult?.data;
  const result: ReadonlyMetricResult<DeliveryRateTrendData> = lossData?.ok
    ? {
        data: {
          trends: lossData.analytics.trends,
        },
        ok: true,
      }
    : { errorCode: lossData?.errorCode ?? 'data_error', ok: false };
  const state = toMetricLoadState(result, isDeliveryRateTrendEmpty);
  logMetricLoadError('delivery_rate_trend', state);

  return (
    <DeliveryRateTrend
      deliveryCountLabel={t('deliveryCount', { delivered: '{delivered}', total: '{total}' })}
      definition={t('definition')}
      emptyLabel={t('empty')}
      errorLabel={t('error')}
      state={state}
      title={t('title')}
    />
  );
}

type TableauPeriodRange = {
  activePeriod: string;
  from: Date;
  to: Date;
};

async function CashByProductPeriodMetric({
  period,
  shopId,
}: {
  period: TableauPeriodRange;
  shopId: string | null;
}) {
  const [tTableau, cashByProductResult] = await Promise.all([
    getTranslations('tableau.blocks.periodMetrics'),
    getDashboardCashCollectedByProduct({ from: period.from, shopId, to: period.to }),
  ]);
  const cashByProductState = toMetricLoadState(cashByProductResult, isCashByProductEmpty);
  logMetricLoadError('cash_by_product', cashByProductState);

  return (
    <TableauCashByProductChart
      emptyLabel={tTableau('empty')}
      errorLabel={tTableau('error')}
      state={cashByProductState}
      subtitle={tTableau('cashByProduct.subtitle')}
      title={tTableau('cashByProduct.title')}
    />
  );
}

async function RevenueSection({ shopId }: { shopId: string | null }) {
  const [t, revenueResult, kpiResult] = await Promise.all([
    getTranslations('tableau'),
    getRevenue30d(shopId),
    loadDashboardKpi(shopId),
  ]);
  const revenue = revenueResult.ok ? revenueResult.data : null;
  const kpi = kpiResult.ok ? kpiResult.data : null;

  return (
    <RevenueChart
      currency={revenue?.currency ?? kpi?.currency ?? null}
      data={revenue?.points ?? []}
      emptyLabel={t('revenue.empty')}
      title={t('revenue.title')}
    />
  );
}

async function TopProductsSection({
  period,
  shopId,
}: {
  period: TableauPeriodRange;
  shopId: string | null;
}) {
  const [t, topProductsResult, kpiResult] = await Promise.all([
    getTranslations('tableau'),
    getTopProducts({ from: period.from, shopId, to: period.to }),
    loadDashboardKpi(shopId),
  ]);
  const topProducts = topProductsResult.ok ? topProductsResult.data : [];
  const kpi = kpiResult.ok ? kpiResult.data : null;

  return (
    <TopProducts
      currency={kpi?.currency ?? null}
      emptyLabel={t('blocks.topProducts.empty')}
      items={topProducts}
      subtitle={t('blocks.topProducts.subtitle')}
      title={t('blocks.topProducts.title')}
      unitsLabel={t('blocks.topProducts.units')}
    />
  );
}

async function ShopPerformanceSection({
  period,
  shopId,
}: {
  period: TableauPeriodRange;
  shopId: string | null;
}) {
  const [t, shopPerformanceResult, kpiResult] = await Promise.all([
    getTranslations('tableau'),
    getShopPerformance({ from: period.from, shopId, to: period.to }),
    loadDashboardKpi(shopId),
  ]);
  const shopPerformance = shopPerformanceResult.ok ? shopPerformanceResult.data : [];
  const kpi = kpiResult.ok ? kpiResult.data : null;

  return (
    <ShopPerformance
      connectedLabel={t('blocks.shopPerformance.connected')}
      currency={kpi?.currency ?? null}
      emptyLabel={t('blocks.shopPerformance.empty')}
      items={shopPerformance}
      ordersLabel={t('blocks.shopPerformance.orders')}
      subtitle={t('blocks.shopPerformance.subtitle')}
      title={t('blocks.shopPerformance.title')}
      warningLabel={t('blocks.shopPerformance.warning')}
    />
  );
}

async function CodBreakdownSection({
  period,
  shopId,
}: {
  period: TableauPeriodRange;
  shopId: string | null;
}) {
  const [t, codBreakdownResult] = await Promise.all([
    getTranslations('tableau'),
    getCodBreakdown({ from: period.from, shopId, to: period.to }),
  ]);
  const codBreakdown = codBreakdownResult.ok ? codBreakdownResult.data : [];

  return (
    <CODStatusBreakdown
      definition={t('blocks.codBreakdown.definition')}
      emptyLabel={t('blocks.codBreakdown.empty')}
      items={codBreakdown}
      subtitle={t('blocks.codBreakdown.subtitle')}
      title={t('blocks.codBreakdown.title')}
    />
  );
}

async function RecentActivitySection({ shopId }: { shopId: string | null }) {
  const [t, recentActivityResult] = await Promise.all([
    getTranslations('tableau'),
    getRecentActivity(shopId),
  ]);
  const recentActivity = recentActivityResult.ok ? recentActivityResult.data : [];

  return (
    <RecentActivity
      emptyLabel={t('blocks.recentActivity.empty')}
      initialLabel={t('blocks.recentActivity.initial')}
      items={recentActivity}
      orderFallbackLabel={t('blocks.recentActivity.orderFallback')}
      title={t('blocks.recentActivity.title')}
    />
  );
}

function KpiStripSkeleton() {
  return (
    <section className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <div className="dashboard-shimmer min-h-[164px] rounded-md sm:col-span-2 xl:col-span-1" />
        {['k2', 'k3', 'k4', 'k5'].map((key) => (
          <div className="dashboard-shimmer min-h-[164px] rounded-md" key={key} />
        ))}
      </div>
      <div className="flex justify-end">
        <div className="dashboard-shimmer h-4 w-32 rounded-sm" />
      </div>
    </section>
  );
}

function ExceptionsSkeleton() {
  const cards = [
    { key: 'urgences', rows: 2 },
    { key: 'livraison', rows: 1 },
    { key: 'annulations', rows: 1 },
  ];

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="dashboard-shimmer h-7 w-44 rounded-sm" />
      </div>
      <div className="grid gap-4 xl:grid-cols-4">
        {cards.map((card) => (
          <article
            className="rounded-lg border border-border bg-surface p-4 shadow-1"
            key={card.key}
          >
            <div className="dashboard-shimmer h-4 w-24 rounded-sm" />
            <div className="mt-4 space-y-3">
              {Array.from({ length: card.rows }, (_, index) => (
                <div className="dashboard-shimmer h-11 rounded-lg" key={`${card.key}-${index}`} />
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function RevenueSkeleton() {
  return (
    <section className="rounded-lg border border-border bg-surface p-4 shadow-1 md:p-6">
      <div className="dashboard-shimmer mb-5 h-5 w-40 rounded-sm" />
      <div className="dashboard-shimmer h-[260px] rounded-md" />
    </section>
  );
}

function OperationsEssentialsSkeleton() {
  return (
    <section className="space-y-3">
      <div className="dashboard-shimmer h-7 w-48 rounded-sm" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {['op1', 'op2', 'op3', 'op4', 'op5', 'op6'].map((key) => (
          <div className="rounded-lg border border-border bg-surface p-4 shadow-1" key={key}>
            <div className="dashboard-shimmer h-4 w-28 rounded-sm" />
            <div className="dashboard-shimmer mt-3 h-8 w-32 rounded-sm" />
          </div>
        ))}
      </div>
    </section>
  );
}

const skeletonRowKeys = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'] as const;

function CardListSkeleton({ rows }: { rows: number }) {
  return (
    <Card className="rounded-lg" padding="lg">
      <div className="dashboard-shimmer mb-5 h-5 w-40 rounded-sm" />
      <div className="space-y-3">
        {skeletonRowKeys.slice(0, rows).map((key) => (
          <div className="dashboard-shimmer h-10 rounded-md" key={key} />
        ))}
      </div>
    </Card>
  );
}

function CodBreakdownSkeleton() {
  return (
    <Card className="rounded-lg" padding="lg">
      <div className="dashboard-shimmer mb-5 h-5 w-40 rounded-sm" />
      <div className="space-y-5">
        <div className="dashboard-shimmer h-3 rounded-full" />
        <div className="grid grid-cols-2 gap-2">
          {skeletonRowKeys.map((key) => (
            <div className="dashboard-shimmer h-4 rounded-sm" key={key} />
          ))}
        </div>
      </div>
    </Card>
  );
}

export default async function TableauPage({ searchParams }: TableauPageProps) {
  const [t, tInvitation, ctx] = await Promise.all([
    getTranslations('tableau'),
    getTranslations('invitation'),
    getCachedDashboardContext(),
  ]);
  const params = await searchParams;
  const requestStoreId = await getRequestStoreId();
  if (!requestStoreId) redirect('/s');
  // Bandeau d'accueil post-acceptation d'invitation (B5) : alimenté par
  // /invitation/accept via ?welcome=<org>&role=<rôle>. Affiché une fois, non
  // bloquant ; on n'affiche que pour un rôle connu.
  const welcomeRole = welcomeRoles.find((role) => role === params.role) ?? null;
  const welcomeBanner =
    params.welcome && welcomeRole
      ? tInvitation('welcome', {
          org: params.welcome,
          role: tInvitation(`roles.${welcomeRole}`),
        })
      : null;
  const user = ctx.ok ? ctx.user : null;
  const shops = [{ id: requestStoreId, label: 'Boutique active' }];
  const selectedShopId = requestStoreId;
  const period = resolvePeriodRange({
    allowedPresets: PERIOD_PRESETS,
    defaultPreset: '30j',
    from: params.from,
    period: params.period,
    to: params.to,
  });
  const periodKey = [period.activePeriod, period.from.toISOString(), period.to.toISOString()].join(
    '-',
  );
  // Suffixe de boutique pour les clés Suspense : il DOIT être combiné a un prefixe
  // unique par bloc. Plusieurs Suspense freres partageant la meme clé littérale
  // (« all ») produisent des clés dupliquees (aggravé par le React.Children.map de
  // DashboardMotion) → au changement de boutique la réconciliation empile les blocs
  // au lieu de les remplacer. Cf. régression empilement KpiStrip.
  const shopKey = selectedShopId ?? 'all';
  const role =
    ctx.ok && (ctx.role === 'owner' || ctx.role === 'manager' || ctx.role === 'agent')
      ? ctx.role
      : 'agent';
  const showFinancialMetrics = role === 'owner' || role === 'manager';
  const firstName =
    displayNameFromMetadata(user?.user_metadata ?? {}) || firstToken(user?.email?.split('@')[0]);

  return (
    <main id="main">
      {welcomeBanner ? (
        <output className="mb-4 block rounded-lg border border-success/30 bg-success-subtle p-3 text-sm font-medium text-success">
          {welcomeBanner}
        </output>
      ) : null}
      <Suspense fallback={null}>
        <ShopFilterPersistence storageKey="teer.tableau.shop" />
      </Suspense>
      <Suspense fallback={null}>
        <TableauPeriodPersistence storeId={requestStoreId} />
      </Suspense>
      <DashboardMotion>
        <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="space-y-2">
            <h1 className="font-display text-4xl md:text-5xl">
              {t('greeting', { name: firstName })}
            </h1>
            <Suspense
              fallback={<div className="dashboard-shimmer h-5 w-80 rounded-sm" />}
              key={`subtitle-${shopKey}`}
            >
              <CallQueueSubtitle shopId={selectedShopId} />
            </Suspense>
          </div>
          <div className="flex flex-col gap-3 md:items-end">
            <PeriodPicker />
            <ShopFilterSelector
              allLabel={t('shops.all')}
              ariaLabel={t('shops.ariaLabel')}
              label={t('shops.label')}
              pathname={`/s/${requestStoreId}/tableau`}
              searchParams={{
                from: params.from,
                period: params.period,
                shop: params.shop,
                to: params.to,
              }}
              selectedShopId={selectedShopId}
              shops={shops}
            />
          </div>
        </header>

        {/* Checklist d'activation — client component, se masque seul quand 100% ou dismissed */}
        <ActivationChecklist />

        <Suspense fallback={<KpiStripSkeleton />} key={`kpi-${shopKey}`}>
          <KpiStrip shopId={selectedShopId} />
        </Suspense>

        <Suspense fallback={<OperationsEssentialsSkeleton />} key={`ops-${shopKey}-${periodKey}`}>
          <OperationsEssentialsSection period={period} shopId={selectedShopId} />
        </Suspense>

        <Suspense
          fallback={<div className="dashboard-shimmer h-[340px] rounded-lg" />}
          key={`delivery-rate-trend-${shopKey}-${periodKey}`}
        >
          <DeliveryRateTrendSection period={period} shopId={selectedShopId} />
        </Suspense>

        <Suspense fallback={<ExceptionsSkeleton />} key={`exceptions-${shopKey}`}>
          <ExceptionsSection shopId={selectedShopId} />
        </Suspense>

        <Suspense fallback={<RevenueSkeleton />} key={`revenue-${shopKey}`}>
          <RevenueSection shopId={selectedShopId} />
        </Suspense>

        <section
          className={cn(
            'grid gap-4',
            showFinancialMetrics ? 'xl:grid-cols-2 min-[1800px]:grid-cols-4' : 'xl:grid-cols-2',
          )}
        >
          {showFinancialMetrics ? (
            <Suspense
              fallback={<CardListSkeleton rows={5} />}
              key={`cash-by-product-${shopKey}-${periodKey}`}
            >
              <CashByProductPeriodMetric period={period} shopId={selectedShopId} />
            </Suspense>
          ) : null}
          <Suspense fallback={<CardListSkeleton rows={5} />} key={`top-${shopKey}-${periodKey}`}>
            <TopProductsSection period={period} shopId={selectedShopId} />
          </Suspense>
          {showFinancialMetrics ? (
            <Suspense
              fallback={<CardListSkeleton rows={5} />}
              key={`shopperf-${shopKey}-${periodKey}`}
            >
              <ShopPerformanceSection period={period} shopId={selectedShopId} />
            </Suspense>
          ) : null}
          <Suspense fallback={<CodBreakdownSkeleton />} key={`cod-${shopKey}-${periodKey}`}>
            <CodBreakdownSection period={period} shopId={selectedShopId} />
          </Suspense>
        </section>

        <section className="grid gap-4 xl:grid-cols-2">
          <Suspense fallback={<CardListSkeleton rows={6} />} key={`activity-${shopKey}`}>
            <RecentActivitySection shopId={selectedShopId} />
          </Suspense>
        </section>
      </DashboardMotion>
    </main>
  );
}
