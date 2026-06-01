import { AlertsBlock } from '@/components/dashboard/AlertsBlock';
import { CODStatusBreakdown } from '@/components/dashboard/CODStatusBreakdown';
import { DashboardMotion } from '@/components/dashboard/DashboardMotion';
import { RecentActivity } from '@/components/dashboard/RecentActivity';
import { RevenueChart } from '@/components/dashboard/RevenueChart';
import { ShopPerformance } from '@/components/dashboard/ShopPerformance';
import { TopProducts } from '@/components/dashboard/TopProducts';
import { NextActionsList } from '@/components/kpi/NextActionsList';
import { DashboardKpiRefresh } from '@/components/kpi/dashboard-kpi-refresh';
import {
  getAlerts,
  getCodBreakdown,
  getDashboardKpi,
  getRecentActivity,
  getRevenue30d,
  getShopPerformance,
  getTopProducts,
} from '@/lib/actions/dashboard';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { ArrowRight } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

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
    ordersT,
    kpiResult,
    revenueResult,
    topProductsResult,
    shopPerformanceResult,
    codBreakdownResult,
    recentActivityResult,
    alertsResult,
  ] = await Promise.all([
    getTranslations('tableau'),
    getTranslations('orders'),
    getDashboardKpi(),
    getRevenue30d(),
    getTopProducts(),
    getShopPerformance(),
    getCodBreakdown(),
    getRecentActivity(),
    getAlerts(),
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
  const alerts = alertsResult.ok ? alertsResult.data : [];
  const callQueueCount = kpi?.a_appeler_count ?? 0;

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
          <AlertsBlock
            emptyLabel={t('blocks.alerts.empty')}
            items={alerts}
            labels={{
              lateCalls: {
                title: t('blocks.alerts.lateCalls.title'),
                value: (count) => t('blocks.alerts.lateCalls.value', { count }),
              },
              shops: {
                title: t('blocks.alerts.shops.title'),
                value: (count) => t('blocks.alerts.shops.value', { count }),
              },
              tokens: {
                title: t('blocks.alerts.tokens.title'),
                value: (count) => t('blocks.alerts.tokens.value', { count }),
              },
            }}
            title={t('blocks.alerts.title')}
          />
        </section>

        <section className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-xl font-semibold">{t('actions.title')}</h2>
            <Link
              className="inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-text hover:bg-surface"
              href="/commandes?statut=a_appeler"
            >
              {t('actions.voir_tout')}
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
          </div>

          <NextActionsList
            callLabel={t('actions.call')}
            emptyLabel={t('actions.empty')}
            emptyValueLabel={ordersT('table.emptyValue')}
          />
        </section>
      </DashboardMotion>
    </main>
  );
}
