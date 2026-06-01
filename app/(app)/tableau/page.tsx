import { RevenueChart } from '@/components/dashboard/RevenueChart';
import { NextActionsList } from '@/components/kpi/NextActionsList';
import { DashboardKpiRefresh } from '@/components/kpi/dashboard-kpi-refresh';
import { getDashboardKpi, getRevenue30d } from '@/lib/actions/dashboard';
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
  const [t, ordersT, kpiResult, revenueResult] = await Promise.all([
    getTranslations('tableau'),
    getTranslations('orders'),
    getDashboardKpi(),
    getRevenue30d(),
  ]);
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const firstName =
    displayNameFromMetadata(user?.user_metadata ?? {}) || firstToken(user?.email?.split('@')[0]);
  const kpi = kpiResult.ok ? kpiResult.data : null;
  const revenue = revenueResult.ok ? revenueResult.data : null;
  const callQueueCount = kpi?.a_appeler_count ?? 0;

  return (
    <main className="space-y-8" id="main">
      <header className="space-y-2">
        <h1 className="font-display text-4xl md:text-5xl">{t('title')}</h1>
        <p className="text-muted">{t('subtitle', { count: callQueueCount, name: firstName })}</p>
      </header>

      <DashboardKpiRefresh initialKpi={kpi} initialUpdatedAt={new Date().toISOString()} />

      <RevenueChart
        currency={revenue?.currency ?? kpi?.currency ?? null}
        data={revenue?.points ?? []}
        emptyLabel={t('revenue.empty')}
        title={t('revenue.title')}
      />

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
          emptyLabel={t('actions.empty')}
          emptyValueLabel={ordersT('table.emptyValue')}
        />
      </section>
    </main>
  );
}
