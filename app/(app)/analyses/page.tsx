import { LossAnalyticsChartsLoader } from '@/components/loss-analytics/loss-analytics-charts-loader';
import { AnalyticsSkeleton } from '@/components/ui/analytics-skeleton';
import { getLossAnalyticsAction } from '@/lib/actions/loss-analytics';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { LockKeyhole } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { Suspense } from 'react';

// Défense (pas le fix) : /analyses agrège des données lourdes (pertes + refuseurs). Le fix
// du 503 est algorithmique (RPC list_repeated_refusers, 0077) ; ce budget évite qu'un pic
// résiduel ne coupe la fonction avant streaming. Réf. vercel.json (shopify-reconcile 300s).
export const maxDuration = 30;

type AnalyticsPageProps = {
  searchParams: Promise<{
    from?: string;
    period?: string;
    to?: string;
  }>;
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

function percent(value: number): string {
  return new Intl.NumberFormat('fr-FR', {
    maximumFractionDigits: 1,
    style: 'percent',
  }).format(value);
}

function count(value: number): string {
  return new Intl.NumberFormat('fr-FR').format(value);
}

function summaryCard(label: string, value: string, description: string) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5">
      <p className="text-[13px] font-medium text-muted">{label}</p>
      <p className="mt-2 font-mono text-2xl font-semibold tabular-nums md:text-3xl">{value}</p>
      <p className="mt-2 text-sm text-muted">{description}</p>
    </section>
  );
}

function metricRow(label: string, value: string, danger?: boolean) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5 text-sm" key={label}>
      <span className="text-muted">{label}</span>
      <span className={`font-mono tabular-nums ${danger ? 'text-danger' : 'text-text'}`}>
        {value}
      </span>
    </div>
  );
}

function metricCard(
  key: string,
  title: string,
  rows: Array<{ danger?: boolean; label: string; value: string }>,
) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3 shadow-1" key={key}>
      <p className="truncate font-medium">{title}</p>
      <div className="mt-2 divide-y divide-border/60">
        {rows.map((row) => metricRow(row.label, row.value, row.danger))}
      </div>
    </div>
  );
}

async function getCurrentRole() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const { data: member } = await supabase
    .from('merchant_member')
    .select('role')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();

  const currentMember = member as { role: string } | null;
  return currentMember?.role ?? null;
}

export default async function AnalyticsPage({ searchParams }: AnalyticsPageProps) {
  const t = await getTranslations('analytics');
  const params = await searchParams;
  const { activePeriod, from, to } = periodRange(params);
  const role = await getCurrentRole();

  if (role !== 'owner' && role !== 'manager') {
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

  const periods = ['today', '7j', '30j'] as const;

  // Shell synchrone (header + formulaire période) rendu immédiatement ; le bloc lourd
  // (fetch loss-analytics) suspend derrière une frontière RÉELLE de streaming. Le `await`
  // n'est PLUS top-level : il vit dans AnalyticsContent, enfant async du Suspense.
  // Suspense keyé sur la période : un changement de ?period=/from/to (même segment de
  // route, ne déclenche PAS loading.tsx) affiche le skeleton au lieu de figer l'ancienne vue.
  return (
    <main className="space-y-6" id="main">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <h1 className="font-display text-4xl md:text-5xl">{t('title')}</h1>
          <p className="max-w-3xl text-muted">{t('subtitle')}</p>
        </div>
        <form className="flex flex-wrap items-end gap-2" method="get">
          <div className="flex rounded-lg border border-border bg-surface p-1 shadow-1">
            {periods.map((period) => (
              <Link
                className={`grid min-h-11 place-items-center rounded-md px-3 text-sm font-medium ${
                  activePeriod === period ? 'bg-accent text-text' : 'text-muted hover:text-text'
                }`}
                href={`/analyses?period=${period}`}
                key={period}
              >
                {t(`periods.${period}`)}
              </Link>
            ))}
          </div>
          <label className="block max-sm:basis-[calc((100%-0.5rem)/2)] max-sm:max-w-[10.5rem] max-sm:min-w-[9rem] w-full min-w-0 space-y-1 text-xs font-medium text-muted sm:w-auto">
            {t('periods.from')}
            <input
              className="block h-11 w-full min-w-0 max-w-full rounded-md border border-border bg-surface px-3 text-sm text-text"
              defaultValue={toDateInput(from)}
              name="from"
              type="date"
            />
          </label>
          <label className="block max-sm:basis-[calc((100%-0.5rem)/2)] max-sm:max-w-[10.5rem] max-sm:min-w-[9rem] w-full min-w-0 space-y-1 text-xs font-medium text-muted sm:w-auto">
            {t('periods.to')}
            <input
              className="block h-11 w-full min-w-0 max-w-full rounded-md border border-border bg-surface px-3 text-sm text-text"
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
      </header>

      <Suspense
        fallback={<AnalyticsSkeleton cards={5} />}
        key={`${activePeriod}-${from.toISOString()}-${to.toISOString()}`}
      >
        <AnalyticsContent fromISO={from.toISOString()} toISO={to.toISOString()} />
      </Suspense>
    </main>
  );
}

async function AnalyticsContent({ fromISO, toISO }: { fromISO: string; toISO: string }) {
  const t = await getTranslations('analytics');

  const actionResult = await getLossAnalyticsAction({ from: fromISO, to: toISO });
  const data = actionResult?.data;

  if (!data?.ok) {
    return (
      <section className="rounded-lg border border-border bg-surface p-5 text-danger shadow-1">
        {t('error')}
      </section>
    );
  }

  const analytics = data.analytics;
  const isEmpty =
    analytics.summary.totalOrders === 0 &&
    analytics.summary.cancellationCount === 0 &&
    analytics.summary.rtoCount === 0 &&
    analytics.summary.returnCount === 0;

  return (
    <>
      {isEmpty ? (
        <section className="rounded-lg border border-border bg-surface p-5 text-muted shadow-1">
          {t('empty')}
        </section>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {summaryCard(
          t('summary.totalOrders'),
          count(analytics.summary.totalOrders),
          t('summary.totalOrders'),
        )}
        {summaryCard(
          t('summary.cancellationRate'),
          percent(analytics.summary.cancellationRate),
          `${count(analytics.summary.cancellationCount)} / ${count(analytics.summary.totalOrders)}`,
        )}
        {summaryCard(
          t('summary.rtoRate'),
          percent(analytics.summary.rtoRate),
          `${t('summary.rtoBase')} : ${count(analytics.summary.rtoDenominator)}`,
        )}
        {summaryCard(
          t('summary.returnRate'),
          percent(analytics.summary.returnRate),
          `${t('summary.returnBase')} : ${count(
            analytics.summary.deliveredCount + analytics.summary.returnCount,
          )}`,
        )}
        {summaryCard(
          t('summary.rtoBase'),
          count(analytics.summary.rtoDenominator),
          `${count(analytics.summary.deliveredCount)} livrées / ${count(analytics.summary.rtoCount)} échecs`,
        )}
      </section>

      <LossAnalyticsChartsLoader
        emptyLabel={t('trends.empty')}
        sourceData={analytics.sourceScorecard.slice(0, 6).map((item) => ({
          cancellationRate: item.cancellationRate,
          rtoRate: item.rtoRate,
          source: item.source,
        }))}
        sourceTitle={t('scorecard.title')}
        trendData={analytics.trends}
        trendTitle={t('trends.title')}
      />

      <section className="space-y-3 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">{t('scorecard.title')}</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="sr-only w-full text-sm md:not-sr-only md:table">
            <thead>
              <tr className="border-b border-border text-left text-muted">
                <th className="px-3 py-3 font-medium">{t('scorecard.source')}</th>
                <th className="px-3 py-3 text-right font-medium">{t('scorecard.totalOrders')}</th>
                <th className="px-3 py-3 text-right font-medium">
                  {t('scorecard.completionRate')}
                </th>
                <th className="px-3 py-3 text-right font-medium">
                  {t('scorecard.cancellationRate')}
                </th>
                <th className="px-3 py-3 text-right font-medium">{t('scorecard.rtoRate')}</th>
                <th className="px-3 py-3 text-right font-medium">{t('scorecard.returnRate')}</th>
              </tr>
            </thead>
            <tbody>
              {analytics.sourceScorecard.map((item) => (
                <tr className="border-b border-border last:border-0" key={item.source}>
                  <td className="px-3 py-3 font-medium">{item.source}</td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums">
                    {count(item.totalOrders)}
                  </td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums">
                    {percent(item.completionRate)}
                  </td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums">
                    {percent(item.cancellationRate)}
                  </td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums text-danger">
                    {percent(item.rtoRate)}
                  </td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums">
                    {percent(item.returnRate)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div aria-hidden="true" className="space-y-2 md:hidden">
          {analytics.sourceScorecard.map((item) =>
            metricCard(item.source, item.source, [
              { label: t('scorecard.totalOrders'), value: count(item.totalOrders) },
              { label: t('scorecard.completionRate'), value: percent(item.completionRate) },
              { label: t('scorecard.cancellationRate'), value: percent(item.cancellationRate) },
              { danger: true, label: t('scorecard.rtoRate'), value: percent(item.rtoRate) },
              { label: t('scorecard.returnRate'), value: percent(item.returnRate) },
            ]),
          )}
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <section className="space-y-3 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5">
          <h2 className="text-lg font-semibold">{t('products.title')}</h2>
          <div className="overflow-x-auto">
            <table className="sr-only w-full text-sm md:not-sr-only md:table">
              <thead>
                <tr className="border-b border-border text-left text-muted">
                  <th className="px-3 py-3 font-medium">{t('products.product')}</th>
                  <th className="px-3 py-3 text-right font-medium">{t('products.orders')}</th>
                  <th className="px-3 py-3 text-right font-medium">{t('products.rtoOrders')}</th>
                  <th className="px-3 py-3 text-right font-medium">{t('products.returnOrders')}</th>
                  <th className="px-3 py-3 text-right font-medium">
                    {t('products.cancellationOrders')}
                  </th>
                  <th className="px-3 py-3 text-right font-medium">{t('products.rtoRate')}</th>
                </tr>
              </thead>
              <tbody>
                {analytics.productLosses.slice(0, 8).map((item) => (
                  <tr
                    className="border-b border-border last:border-0"
                    key={`${item.productId ?? 'none'}-${item.name}`}
                  >
                    <td className="px-3 py-3">
                      <div className="font-medium">{item.name}</div>
                      {item.sku ? <div className="text-xs text-muted">{item.sku}</div> : null}
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">
                      {count(item.totalOrders)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums text-danger">
                      {count(item.rtoOrders)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">
                      {count(item.returnOrders)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">
                      {count(item.cancellationOrders)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">
                      {percent(item.rtoRate)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div aria-hidden="true" className="space-y-2 md:hidden">
            {analytics.productLosses.slice(0, 8).map((item) =>
              metricCard(`${item.productId ?? 'none'}-${item.name}`, item.name, [
                { label: t('products.orders'), value: count(item.totalOrders) },
                { danger: true, label: t('products.rtoOrders'), value: count(item.rtoOrders) },
                { label: t('products.returnOrders'), value: count(item.returnOrders) },
                {
                  label: t('products.cancellationOrders'),
                  value: count(item.cancellationOrders),
                },
                { label: t('products.rtoRate'), value: percent(item.rtoRate) },
              ]),
            )}
          </div>
        </section>

        <section className="space-y-3 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5">
          <h2 className="text-lg font-semibold">{t('zones.title')}</h2>
          <div className="overflow-x-auto">
            <table className="sr-only w-full text-sm md:not-sr-only md:table">
              <thead>
                <tr className="border-b border-border text-left text-muted">
                  <th className="px-3 py-3 font-medium">{t('zones.zone')}</th>
                  <th className="px-3 py-3 text-right font-medium">{t('zones.orders')}</th>
                  <th className="px-3 py-3 text-right font-medium">{t('zones.rtoOrders')}</th>
                  <th className="px-3 py-3 text-right font-medium">{t('zones.returnOrders')}</th>
                  <th className="px-3 py-3 text-right font-medium">
                    {t('zones.cancellationOrders')}
                  </th>
                  <th className="px-3 py-3 text-right font-medium">{t('zones.rtoRate')}</th>
                </tr>
              </thead>
              <tbody>
                {analytics.zoneLosses.slice(0, 8).map((item) => (
                  <tr className="border-b border-border last:border-0" key={item.label}>
                    <td className="px-3 py-3 font-medium">{item.label}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">
                      {count(item.totalOrders)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums text-danger">
                      {count(item.rtoOrders)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">
                      {count(item.returnOrders)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">
                      {count(item.cancellationOrders)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">
                      {percent(item.rtoRate)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div aria-hidden="true" className="space-y-2 md:hidden">
            {analytics.zoneLosses.slice(0, 8).map((item) =>
              metricCard(item.label, item.label, [
                { label: t('zones.orders'), value: count(item.totalOrders) },
                { danger: true, label: t('zones.rtoOrders'), value: count(item.rtoOrders) },
                { label: t('zones.returnOrders'), value: count(item.returnOrders) },
                {
                  label: t('zones.cancellationOrders'),
                  value: count(item.cancellationOrders),
                },
                { label: t('zones.rtoRate'), value: percent(item.rtoRate) },
              ]),
            )}
          </div>
        </section>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">
        <section className="space-y-3 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5">
          <h2 className="text-lg font-semibold">{t('drivers.title')}</h2>
          <div className="overflow-x-auto">
            <table className="sr-only w-full text-sm md:not-sr-only md:table">
              <thead>
                <tr className="border-b border-border text-left text-muted">
                  <th className="px-3 py-3 font-medium">{t('drivers.driver')}</th>
                  <th className="px-3 py-3 text-right font-medium">{t('drivers.outcomeOrders')}</th>
                  <th className="px-3 py-3 text-right font-medium">{t('drivers.rtoOrders')}</th>
                  <th className="px-3 py-3 text-right font-medium">{t('drivers.returnOrders')}</th>
                  <th className="px-3 py-3 text-right font-medium">{t('drivers.rtoRate')}</th>
                </tr>
              </thead>
              <tbody>
                {analytics.driverPerformance.map((item) => (
                  <tr className="border-b border-border last:border-0" key={item.driverId}>
                    <td className="px-3 py-3 font-medium">{item.driverName}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">
                      {count(item.outcomeOrders)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums text-danger">
                      {count(item.rtoOrders)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">
                      {count(item.returnOrders)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">
                      {percent(item.rtoRate)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div aria-hidden="true" className="space-y-2 md:hidden">
            {analytics.driverPerformance.map((item) =>
              metricCard(item.driverId, item.driverName, [
                { label: t('drivers.outcomeOrders'), value: count(item.outcomeOrders) },
                { danger: true, label: t('drivers.rtoOrders'), value: count(item.rtoOrders) },
                { label: t('drivers.returnOrders'), value: count(item.returnOrders) },
                { label: t('drivers.rtoRate'), value: percent(item.rtoRate) },
              ]),
            )}
          </div>
        </section>

        <section className="space-y-3 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5">
          <h2 className="text-lg font-semibold">{t('reasons.title')}</h2>
          <div className="overflow-x-auto">
            <table className="sr-only w-full text-sm md:not-sr-only md:table">
              <thead>
                <tr className="border-b border-border text-left text-muted">
                  <th className="px-3 py-3 font-medium">{t('reasons.reason')}</th>
                  <th className="px-3 py-3 text-right font-medium">{t('reasons.count')}</th>
                </tr>
              </thead>
              <tbody>
                {analytics.reasonBreakdown.slice(0, 8).map((item) => (
                  <tr className="border-b border-border last:border-0" key={item.reason}>
                    <td className="px-3 py-3 font-medium">{item.reason}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">
                      {count(item.count)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div aria-hidden="true" className="space-y-2 md:hidden">
            {analytics.reasonBreakdown
              .slice(0, 8)
              .map((item) =>
                metricCard(item.reason, item.reason, [
                  { label: t('reasons.count'), value: count(item.count) },
                ]),
              )}
          </div>
        </section>
      </section>

      <section className="space-y-3 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5">
        <h2 className="text-lg font-semibold">{t('refusers.title')}</h2>
        {analytics.repeatedRefusers.length === 0 ? (
          <p className="text-sm text-muted">{t('refusers.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="sr-only w-full text-sm md:not-sr-only md:table">
              <thead>
                <tr className="border-b border-border text-left text-muted">
                  <th className="px-3 py-3 font-medium">{t('refusers.customer')}</th>
                  <th className="px-3 py-3 text-right font-medium">{t('refusers.orders')}</th>
                  <th className="px-3 py-3 text-right font-medium">{t('refusers.refused')}</th>
                  <th className="px-3 py-3 font-medium">{t('refusers.tier')}</th>
                  <th className="px-3 py-3 font-medium">{t('refusers.action')}</th>
                </tr>
              </thead>
              <tbody>
                {analytics.repeatedRefusers.map((item) => (
                  <tr className="border-b border-border last:border-0" key={item.customerId}>
                    <td className="px-3 py-3 font-medium">{item.fullName ?? item.customerId}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums">
                      {count(item.orderCount)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums text-danger">
                      {count(item.refusedCount)}
                    </td>
                    <td className="px-3 py-3">{item.tier}</td>
                    <td className="px-3 py-3 text-sm text-muted">{t('refusers.deposit')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {analytics.repeatedRefusers.length > 0 ? (
          <div aria-hidden="true" className="space-y-2 md:hidden">
            {analytics.repeatedRefusers.map((item) =>
              metricCard(item.customerId, item.fullName ?? item.customerId, [
                { label: t('refusers.orders'), value: count(item.orderCount) },
                { danger: true, label: t('refusers.refused'), value: count(item.refusedCount) },
                { label: t('refusers.tier'), value: item.tier },
                { label: t('refusers.action'), value: t('refusers.deposit') },
              ]),
            )}
          </div>
        ) : null}
      </section>
    </>
  );
}
