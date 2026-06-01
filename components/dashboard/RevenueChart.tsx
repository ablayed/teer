'use client';

import type { DashboardRevenuePoint } from '@/lib/actions/dashboard';
import dynamic from 'next/dynamic';

const RevenueChartInner = dynamic(() => import('@/components/dashboard/RevenueChartInner'), {
  loading: () => (
    <section className="rounded-lg border border-border bg-surface p-4 shadow-1 md:p-6">
      <div className="dashboard-shimmer mb-5 h-5 w-40 rounded-sm" />
      <div className="dashboard-shimmer h-[260px] rounded-md" />
    </section>
  ),
  ssr: false,
});

type RevenueChartProps = {
  currency: string | null;
  data: DashboardRevenuePoint[];
  emptyLabel: string;
  title: string;
};

export function RevenueChart(props: RevenueChartProps) {
  return <RevenueChartInner {...props} />;
}
