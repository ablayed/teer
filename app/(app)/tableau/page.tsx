import { CODStatusBreakdown } from '@/components/dashboard/CODStatusBreakdown';
import { DashboardMotion } from '@/components/dashboard/DashboardMotion';
import { OrderExceptionsGrid } from '@/components/dashboard/OrderExceptionsGrid';
import { RecentActivity } from '@/components/dashboard/RecentActivity';
import { RevenueChart } from '@/components/dashboard/RevenueChart';
import { ShopPerformance } from '@/components/dashboard/ShopPerformance';
import { TopProducts } from '@/components/dashboard/TopProducts';
import { DashboardKpiRefresh } from '@/components/kpi/dashboard-kpi-refresh';
import {
  getCodBreakdown,
  getDashboardKpi,
  getRecentActivity,
  getRevenue30d,
  getShopPerformance,
  getTopProducts,
} from '@/lib/actions/dashboard';
import { getOrders } from '@/lib/actions/orders';
import {
  buildOrderViewHref,
  isSameLocalDate,
  matchesOrderSavedView,
} from '@/lib/domain/order-saved-views';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getTranslations } from 'next-intl/server';

function firstToken(value: string | null | undefined): string {
  return value?.trim().split(/\s+/)[0] ?? '';
}

function displayNameFromMetadata(metadata: Record<string, unknown>): string {
  const name = metadata.full_name ?? metadata.name;

  return typeof name === 'string' ? firstToken(name) : '';
}

export default async function TableauPage() {
  const [
    t,
    kpiResult,
    revenueResult,
    topProductsResult,
    shopPerformanceResult,
    codBreakdownResult,
    recentActivityResult,
    orders,
  ] = await Promise.all([
    getTranslations('tableau'),
    getDashboardKpi(),
    getRevenue30d(),
    getTopProducts(),
    getShopPerformance(),
    getCodBreakdown(),
    getRecentActivity(),
    getOrders(),
  ]);
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const firstName =
    displayNameFromMetadata(user?.user_metadata ?? {}) || firstToken(user?.email?.split('@')[0]);
  const kpi = kpiResult.ok ? kpiResult.data : null;
  const revenue = revenueResult.ok ? revenueResult.data : null;
  const topProducts = topProductsResult.ok ? topProductsResult.data : [];
  const shopPerformance = shopPerformanceResult.ok ? shopPerformanceResult.data : [];
  const codBreakdown = codBreakdownResult.ok ? codBreakdownResult.data : [];
  const recentActivity = recentActivityResult.ok ? recentActivityResult.data : [];
  const callQueueCount = kpi?.a_appeler_count ?? 0;
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
      title: 'Livraison du jour',
      rows: [
        {
          count: orders.filter((order) => matchesOrderSavedView(order, 'a-livrer-aujourdhui'))
            .length,
          href: buildOrderViewHref('a-livrer-aujourdhui'),
          label: "A livrer aujourd'hui",
        },
      ],
    },
    {
      title: 'Tresorerie',
      rows: [
        {
          count: orders.filter((order) => matchesOrderSavedView(order, 'cash-a-remettre')).length,
          href: buildOrderViewHref('cash-a-remettre'),
          label: 'Cash a remettre',
        },
      ],
    },
    {
      title: 'Retours',
      rows: [
        {
          count: orders.filter((order) => matchesOrderSavedView(order, 'retours')).length,
          href: buildOrderViewHref('retours'),
          label: 'Retours',
        },
      ],
    },
  ];

  return (
    <main id="main">
      <DashboardMotion>
        <header className="space-y-2">
          <h1 className="font-display text-4xl md:text-5xl">
            {t('greeting', { name: firstName })}
          </h1>
          <p className="text-muted">{t('subtitle', { count: callQueueCount })}</p>
        </header>

        <DashboardKpiRefresh initialKpi={kpi} initialUpdatedAt={new Date().toISOString()} />

        <OrderExceptionsGrid cards={exceptionCards} title="Exceptions a traiter" />

        <RevenueChart
          currency={revenue?.currency ?? kpi?.currency ?? null}
          data={revenue?.points ?? []}
          emptyLabel={t('revenue.empty')}
          title={t('revenue.title')}
        />

        <section className="grid gap-4 xl:grid-cols-3">
          <TopProducts
            currency={kpi?.currency ?? null}
            emptyLabel={t('blocks.topProducts.empty')}
            items={topProducts}
            title={t('blocks.topProducts.title')}
            unitsLabel={t('blocks.topProducts.units')}
          />
          <ShopPerformance
            connectedLabel={t('blocks.shopPerformance.connected')}
            currency={kpi?.currency ?? null}
            emptyLabel={t('blocks.shopPerformance.empty')}
            items={shopPerformance}
            ordersLabel={t('blocks.shopPerformance.orders')}
            title={t('blocks.shopPerformance.title')}
            warningLabel={t('blocks.shopPerformance.warning')}
          />
          <CODStatusBreakdown
            emptyLabel={t('blocks.codBreakdown.empty')}
            items={codBreakdown}
            title={t('blocks.codBreakdown.title')}
          />
        </section>

        <section className="grid gap-4 xl:grid-cols-2">
          <RecentActivity
            emptyLabel={t('blocks.recentActivity.empty')}
            initialLabel={t('blocks.recentActivity.initial')}
            items={recentActivity}
            orderFallbackLabel={t('blocks.recentActivity.orderFallback')}
            title={t('blocks.recentActivity.title')}
          />
        </section>
      </DashboardMotion>
    </main>
  );
}
