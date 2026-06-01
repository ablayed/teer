'use client';

import dynamic from 'next/dynamic';

const skeletonKeys = ['revenue', 'funnel', 'shops', 'aging'];

export const FinanceChartsLoader = dynamic(
  () => import('@/components/finance/FinanceCharts').then((mod) => mod.FinanceCharts),
  {
    loading: () => (
      <section className="grid gap-4 xl:grid-cols-2">
        {skeletonKeys.map((key) => (
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
