import { CODStatusBreakdown } from '@/components/dashboard/CODStatusBreakdown';
import { DashboardMotion } from '@/components/dashboard/DashboardMotion';
import { OrderExceptionsGrid } from '@/components/dashboard/OrderExceptionsGrid';
import { RecentActivity } from '@/components/dashboard/RecentActivity';
import { RevenueChart } from '@/components/dashboard/RevenueChart';
import { ShopPerformance } from '@/components/dashboard/ShopPerformance';
import { TopProducts } from '@/components/dashboard/TopProducts';
import { DashboardKpiRefresh } from '@/components/kpi/dashboard-kpi-refresh';
import { ActivationChecklist } from '@/components/onboarding/activation-checklist';
import { ShopFilterPersistence } from '@/components/shops/shop-filter-persistence';
import { ShopFilterSelector } from '@/components/shops/shop-filter-selector';
import { Card } from '@/components/ui/card';
import {
  getCodBreakdown,
  getDashboardKpi,
  getRecentActivity,
  getRevenue30d,
  getShopPerformance,
  getTopProducts,
} from '@/lib/actions/dashboard';
import { getDriversCashOnHandTotal } from '@/lib/actions/drivers';
import { getLossAnalyticsAction } from '@/lib/actions/loss-analytics';
import { getOrders } from '@/lib/actions/orders';
import {
  buildOrderViewHref,
  isSameLocalDate,
  matchesOrderSavedView,
} from '@/lib/domain/order-saved-views';
import { formatMoney } from '@/lib/format/fcfa';
import { listShopFilterOptions, normalizeShopParam } from '@/lib/shops/shop-filter';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getTranslations } from 'next-intl/server';
import { Suspense, cache } from 'react';

type TableauPageProps = {
  searchParams: Promise<{
    shop?: string;
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

async function ExceptionsSection({ shopId }: { shopId: string | null }) {
  const orders = await getOrders({ shopId });
  const callbackTodayCount = orders.filter(
    (order) =>
      order.order_state === 'open' &&
      order.call_state === 'callback' &&
      isSameLocalDate(order.next_contact_at),
  ).length;
  const exceptionCards = [
    {
      title: 'Urgences du jour',
      rows: [
        {
          count: orders.filter((order) => matchesOrderSavedView(order, 'a-appeler')).length,
          href: buildOrderViewHref('a-appeler'),
          label: 'A appeler',
        },
        {
          count: callbackTodayCount,
          href: buildOrderViewHref('tentee-a-rappeler'),
          label: "A rappeler aujourd'hui",
        },
      ],
    },
    {
      title: 'Livraison',
      rows: [
        {
          count: orders.filter((order) => matchesOrderSavedView(order, 'en-livraison')).length,
          href: buildOrderViewHref('en-livraison'),
          label: 'En cours de livraison',
        },
      ],
    },
    // Note : la carte « Tresorerie / Cash a remettre » est retiree de l'Apercu Commandes.
    // Le cash se gere desormais dans Finances / Livreurs (hors perimetre Commandes).
    {
      title: 'Annulations & retours',
      rows: [
        {
          count: orders.filter((order) => matchesOrderSavedView(order, 'annulees-retours')).length,
          href: buildOrderViewHref('annulees-retours'),
          label: 'Annulées / Retours',
        },
      ],
    },
  ];

  return <OrderExceptionsGrid cards={exceptionCards} title="Exceptions a traiter" />;
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
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: member } = await supabase
    .from('merchant_member')
    .select('role')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();
  const role = (member as { role: string } | null)?.role ?? null;
  if (role !== 'owner' && role !== 'manager') return null;

  const now = new Date();
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - 29);

  const [cashTotal, lossResult] = await Promise.all([
    getDriversCashOnHandTotal(),
    getLossAnalyticsAction({ from: from.toISOString(), shopId, to: now.toISOString() }),
  ]);

  const loss = lossResult?.data?.ok ? lossResult.data.analytics.summary : null;
  const pct = (ratio: number) =>
    new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1, style: 'percent' }).format(ratio);
  const deliveryRate =
    loss && loss.rtoDenominator > 0 ? loss.deliveredCount / loss.rtoDenominator : 0;

  const cashHint = cashTotal.ok
    ? [`${cashTotal.driverCount} livreur(s) concerné(s)`, shopId ? '· toutes boutiques' : null]
        .filter(Boolean)
        .join(' ')
    : undefined;

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Essentiels opérations (30 j)</h2>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
  const [t, tInvitation, supabase] = await Promise.all([
    getTranslations('tableau'),
    getTranslations('invitation'),
    createSupabaseServerClient(),
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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  let merchantAccountId: string | null = null;
  if (user) {
    const { data: memberRow } = await supabase
      .from('merchant_member')
      .select('merchant_account_id')
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle();
    const member = memberRow as { merchant_account_id: string } | null;
    merchantAccountId = member?.merchant_account_id ?? null;
  }
  const shops = merchantAccountId ? await listShopFilterOptions(supabase, merchantAccountId) : [];
  const selectedShopId = normalizeShopParam(params.shop, shops);
  // Suffixe de boutique pour les clés Suspense : il DOIT être combiné a un prefixe
  // unique par bloc. Plusieurs Suspense freres partageant la meme clé littérale
  // (« all ») produisent des clés dupliquees (aggravé par le React.Children.map de
  // DashboardMotion) → au changement de boutique la réconciliation empile les blocs
  // au lieu de les remplacer. Cf. régression empilement KpiStrip.
  const shopKey = selectedShopId ?? 'all';
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
          <ShopFilterSelector
            allLabel={t('shops.all')}
            ariaLabel={t('shops.ariaLabel')}
            label={t('shops.label')}
            pathname="/tableau"
            searchParams={{ shop: params.shop }}
            selectedShopId={selectedShopId}
            shops={shops}
          />
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
