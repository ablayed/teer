'use client';

import dynamic from 'next/dynamic';

export const LossAnalyticsChartsLoader = dynamic(
  () =>
    import('@/components/loss-analytics/loss-analytics-charts').then(
      (mod) => mod.LossAnalyticsCharts,
    ),
  {
    loading: () => (
      <section className="grid gap-4 xl:grid-cols-2">
        {[0, 1].map((key) => (
          <div
            className="h-[280px] animate-pulse rounded-lg border border-border bg-surface shadow-1"
            key={key}
          />
        ))}
      </section>
    ),
    ssr: false,
  },
);
