import { CODStatusBreakdown } from '@/components/dashboard/CODStatusBreakdown';
import { DashboardMotion } from '@/components/dashboard/DashboardMotion';
import { OrderExceptionsGrid } from '@/components/dashboard/OrderExceptionsGrid';
import { RecentActivity } from '@/components/dashboard/RecentActivity';
import { RevenueChart } from '@/components/dashboard/RevenueChart';
import { ShopPerformance } from '@/components/dashboard/ShopPerformance';
import { TopProducts } from '@/components/dashboard/TopProducts';
import {
  TableauCashByProductChart,
  TableauCashCollectedCard,
  TableauDeliveriesCard,
} from '@/components/dashboard/tableau-period-metrics';
import { TableauPeriodPersistence } from '@/components/dashboard/tableau-period-persistence';
import { DashboardKpiRefresh } from '@/components/kpi/dashboard-kpi-refresh';
import { ActivationChecklist } from '@/components/onboarding/activation-checklist';
import { PeriodPicker } from '@/components/period-picker/period-picker';
import { ShopFilterPersistence } from '@/components/shops/shop-filter-persistence';
import { ShopFilterSelector } from '@/components/shops/shop-filter-selector';
import { Card } from '@/components/ui/card';
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
import { buildOrderViewHref } from '@/lib/domain/order-saved-views';
import { formatMoney } from '@/lib/format/fcfa';
import { PERIOD_PRESETS, resolvePeriodRange } from '@/lib/periods/date-range';
import { listShopFilterOptions, normalizeShopParam } from '@/lib/shops/shop-filter';
import { getTranslations } from 'next-intl/server';
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

function essentialCard(label: string, value: string, hint?: string) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4 shadow-1">
      <p className="text-[13px] font-medium text-muted">{label}</p>
      <p className="mt-2 font-mono text-2xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </section>
  );
}

// Essentiels opérations (owner/manager) : cash total chez tous les livreurs (réutilise
// cash-consolidation) + taux d'annulation / livraison réussie / retour (réutilise
// getLossAnalyticsAction, période-aware 30 j). /analyses reste la vue détaillée.
async function OperationsEssentialsSection({ shopId }: { shopId: string | null }) {
  const ctx = await getCachedDashboardContext();
  if (!ctx.ok) return null;
  if (ctx.role !== 'owner' && ctx.role !== 'manager') return null;

  const now = new Date();
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - 29);

  const [cashTotal, lossResult] = await Promise.all([
    getDriversCashOnHandTotal(shopId),
    getLossAnalyticsAction({ from: from.toISOString(), shopId, to: now.toISOString() }),
  ]);

  const loss = lossResult?.data?.ok ? lossResult.data.analytics.summary : null;
  const pct = (ratio: number) =>
    new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1, style: 'percent' }).format(ratio);
  const deliveryRate =
    loss && loss.rtoDenominator > 0 ? loss.deliveredCount / loss.rtoDenominator : 0;

  const cashHint = cashTotal.ok ? `${cashTotal.driverCount} livreur(s) concerné(s)` : undefined;

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Essentiels opérations (30 j)</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {essentialCard(
          'Cash total chez les livreurs',
          formatMoney(cashTotal.ok ? cashTotal.totalMinor : 0, 'XOF'),
          cashHint,
        )}
        {essentialCard("Taux d'annulation", loss ? pct(loss.cancellationRate) : '—')}
        {essentialCard('Taux de livraison réussie', loss ? pct(deliveryRate) : '—')}
        {essentialCard('Taux de retour', loss ? pct(loss.returnRate) : '—')}
      </div>
    </section>
  );
}

type TableauPeriodRange = {
  activePeriod: string;
  from: Date;
  to: Date;
};

async function PeriodMetricsSection({
  period,
  role,
  shopId,
}: {
  period: TableauPeriodRange;
  role: 'agent' | 'manager' | 'owner';
  shopId: string | null;
}) {
  const [tTableau, tFinance, cashCollectedResult, deliveriesResult, cashByProductResult] =
    await Promise.all([
      getTranslations('tableau.blocks.periodMetrics'),
      getTranslations('finance.profit'),
      role === 'owner' || role === 'manager'
        ? getDashboardCashCollectedTotal({ from: period.from, shopId, to: period.to })
        : Promise.resolve(null),
      getDashboardDeliveriesByProduct({ from: period.from, shopId, to: period.to }),
      role === 'owner' || role === 'manager'
        ? getDashboardCashCollectedByProduct({ from: period.from, shopId, to: period.to })
        : Promise.resolve(null),
    ]);

  const cashCollected = cashCollectedResult?.ok ? cashCollectedResult.data.caMinor : 0;
  const cashByProduct = cashByProductResult?.ok
    ? cashByProductResult.data
    : { items: [], totalMinor: 0 };
  const deliveries = deliveriesResult.ok
    ? deliveriesResult.data
    : { products: [], totalDeliveries: 0 };
  const showCash = role === 'owner' || role === 'manager';

  return (
    <section
      aria-label={tTableau('sectionLabel')}
      className={`grid gap-4 ${showCash ? 'xl:grid-cols-3' : 'xl:grid-cols-1'}`}
    >
      {showCash ? (
        <>
          <TableauCashCollectedCard
            emptyLabel={tTableau('empty')}
            title={tFinance('ca')}
            valueMinor={cashCollected}
          />
          <TableauCashByProductChart
            chart={cashByProduct}
            emptyLabel={tTableau('empty')}
            subtitle={tTableau('cashByProduct.subtitle')}
            title={tTableau('cashByProduct.title')}
          />
        </>
      ) : null}
      <TableauDeliveriesCard
        deliveries={deliveries}
        emptyLabel={tTableau('empty')}
        subtitle={tTableau('deliveries.subtitle')}
        title={tTableau('deliveries.title')}
        totalLabel={tTableau('deliveries.total')}
      />
    </section>
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

async function TopProductsSection({ shopId }: { shopId: string | null }) {
  const [t, topProductsResult, kpiResult] = await Promise.all([
    getTranslations('tableau'),
    getTopProducts(shopId),
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

async function ShopPerformanceSection({ shopId }: { shopId: string | null }) {
  const [t, shopPerformanceResult, kpiResult] = await Promise.all([
    getTranslations('tableau'),
    getShopPerformance(shopId),
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

async function CodBreakdownSection({ shopId }: { shopId: string | null }) {
  const [t, codBreakdownResult] = await Promise.all([
    getTranslations('tableau'),
    getCodBreakdown(shopId),
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

function PeriodMetricsSkeleton({ showCash }: { showCash: boolean }) {
  const keys = showCash ? ['cash', 'cash-by-product', 'deliveries'] : ['deliveries'];

  return (
    <section className={`grid gap-4 ${showCash ? 'xl:grid-cols-3' : 'xl:grid-cols-1'}`}>
      {keys.map((key) => (
        <Card className="rounded-lg" key={key} padding="lg">
          <div className="dashboard-shimmer mb-5 h-5 w-40 rounded-sm" />
          <div className="dashboard-shimmer h-[220px] rounded-md" />
        </Card>
      ))}
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
  const shops = ctx.ok ? await listShopFilterOptions(ctx.supabase, ctx.merchantAccountId) : [];
  const selectedShopId = normalizeShopParam(params.shop, shops);
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
        <TableauPeriodPersistence />
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
              pathname="/tableau"
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

        <Suspense
          fallback={<div className="dashboard-shimmer h-36 rounded-md" />}
          key={`ops-${shopKey}`}
        >
          <OperationsEssentialsSection shopId={selectedShopId} />
        </Suspense>

        <Suspense
          fallback={<PeriodMetricsSkeleton showCash={role === 'owner' || role === 'manager'} />}
          key={`period-metrics-${shopKey}-${periodKey}`}
        >
          <PeriodMetricsSection period={period} role={role} shopId={selectedShopId} />
        </Suspense>

        <Suspense fallback={<ExceptionsSkeleton />} key={`exceptions-${shopKey}`}>
          <ExceptionsSection shopId={selectedShopId} />
        </Suspense>

        <Suspense fallback={<RevenueSkeleton />} key={`revenue-${shopKey}`}>
          <RevenueSection shopId={selectedShopId} />
        </Suspense>

        <section className="grid gap-4 xl:grid-cols-3">
          <Suspense fallback={<CardListSkeleton rows={5} />} key={`top-${shopKey}`}>
            <TopProductsSection shopId={selectedShopId} />
          </Suspense>
          <Suspense fallback={<CardListSkeleton rows={5} />} key={`shopperf-${shopKey}`}>
            <ShopPerformanceSection shopId={selectedShopId} />
          </Suspense>
          <Suspense fallback={<CodBreakdownSkeleton />} key={`cod-${shopKey}`}>
            <CodBreakdownSection shopId={selectedShopId} />
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
