'use client';

import type { LossAnalyticsTrendPoint } from '@/lib/loss-analytics/metrics';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

type LossAnalyticsChartsProps = {
  emptyLabel: string;
  sourceData: Array<{
    cancellationRate: number;
    rtoRate: number;
    source: string;
  }>;
  sourceTitle: string;
  trendData: LossAnalyticsTrendPoint[];
  trendTitle: string;
};

function formatPercent(value: number): string {
  return new Intl.NumberFormat('fr-FR', {
    maximumFractionDigits: 0,
    style: 'percent',
  }).format(value);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short' }).format(
    new Date(value),
  );
}

function ChartCard({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <section className="min-h-[280px] rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5">
      <h2 className="mb-4 text-[15px] font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function EmptyChart({ label }: { label: string }) {
  return <div className="grid h-56 place-items-center text-sm text-muted">{label}</div>;
}

export function LossAnalyticsCharts({
  emptyLabel,
  sourceData,
  sourceTitle,
  trendData,
  trendTitle,
}: LossAnalyticsChartsProps) {
  const hasTrendData = trendData.some((point) => point.rtoDenominator > 0);
  const hasSourceData = sourceData.some((point) => point.rtoRate > 0 || point.cancellationRate > 0);

  return (
    <section className="grid gap-4 xl:grid-cols-2">
      <ChartCard title={trendTitle}>
        {hasTrendData ? (
          <ResponsiveContainer height={240} width="100%">
            <AreaChart data={trendData}>
              <defs>
                <linearGradient id="lossAnalyticsRto" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="var(--danger)" stopOpacity={0.22} />
                  <stop offset="100%" stopColor="var(--danger)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis
                axisLine={false}
                dataKey="date"
                tickFormatter={formatDate}
                tickLine={false}
                tick={{ fill: 'var(--muted)', fontFamily: 'var(--font-geist-mono)', fontSize: 12 }}
              />
              <YAxis
                axisLine={false}
                domain={[0, 1]}
                tickFormatter={formatPercent}
                tickLine={false}
                tick={{ fill: 'var(--muted)', fontFamily: 'var(--font-geist-mono)', fontSize: 12 }}
                width={52}
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                  boxShadow: 'var(--shadow-2)',
                }}
                formatter={(value) => formatPercent(Number(value))}
                labelFormatter={(label) => (typeof label === 'string' ? formatDate(label) : '')}
              />
              <Area
                dataKey="rtoRate"
                fill="url(#lossAnalyticsRto)"
                isAnimationActive={false}
                stroke="var(--danger)"
                strokeWidth={2}
                type="monotone"
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <EmptyChart label={emptyLabel} />
        )}
      </ChartCard>

      <ChartCard title={sourceTitle}>
        {hasSourceData ? (
          <ResponsiveContainer height={240} width="100%">
            <BarChart data={sourceData}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis
                axisLine={false}
                dataKey="source"
                tickLine={false}
                tick={{ fill: 'var(--muted)', fontSize: 12 }}
              />
              <YAxis
                axisLine={false}
                domain={[0, 1]}
                tickFormatter={formatPercent}
                tickLine={false}
                tick={{ fill: 'var(--muted)', fontFamily: 'var(--font-geist-mono)', fontSize: 12 }}
                width={52}
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                  boxShadow: 'var(--shadow-2)',
                }}
                formatter={(value) => formatPercent(Number(value))}
              />
              <Bar dataKey="rtoRate" fill="var(--danger)" isAnimationActive={false} radius={8} />
              <Bar
                dataKey="cancellationRate"
                fill="var(--muted)"
                isAnimationActive={false}
                radius={8}
              />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <EmptyChart label={emptyLabel} />
        )}
      </ChartCard>
    </section>
  );
}
