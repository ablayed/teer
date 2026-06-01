'use client';

import { formatMoney } from '@/lib/format/fcfa';
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

type RevenuePoint = {
  date: string;
  value: number;
};

type FunnelPoint = {
  count: number;
  label: string;
};

type ShopPoint = {
  name: string;
  revenue: number;
};

type AgingPoint = {
  bucket_1_3d: number;
  bucket_gt3d: number;
  bucket_lt1d: number;
  driver_name: string;
};

type FinanceChartsProps = {
  aging: AgingPoint[];
  agingTitle: string;
  currency: string;
  emptyLabel: string;
  funnel: FunnelPoint[];
  funnelTitle: string;
  revenue: RevenuePoint[];
  revenueTitle: string;
  shops: ShopPoint[];
  shopsTitle: string;
};

function compactMoney(value: number): string {
  return new Intl.NumberFormat('fr-FR', {
    compactDisplay: 'short',
    maximumFractionDigits: 1,
    notation: 'compact',
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

export function FinanceCharts({
  aging,
  agingTitle,
  currency,
  emptyLabel,
  funnel,
  funnelTitle,
  revenue,
  revenueTitle,
  shops,
  shopsTitle,
}: FinanceChartsProps) {
  const hasRevenue = revenue.some((point) => point.value > 0);
  const hasFunnel = funnel.some((point) => point.count > 0);
  const hasShops = shops.some((point) => point.revenue > 0);
  const hasAging = aging.some(
    (point) => point.bucket_lt1d + point.bucket_1_3d + point.bucket_gt3d > 0,
  );

  return (
    <section className="grid gap-4 xl:grid-cols-2">
      <ChartCard title={revenueTitle}>
        {hasRevenue ? (
          <ResponsiveContainer height={240} width="100%">
            <AreaChart data={revenue}>
              <defs>
                <linearGradient id="financeRevenue" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.18} />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
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
                tickFormatter={compactMoney}
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
                formatter={(value) => formatMoney(Number(value), currency)}
                labelFormatter={(label) => (typeof label === 'string' ? formatDate(label) : '')}
              />
              <Area
                dataKey="value"
                fill="url(#financeRevenue)"
                isAnimationActive={false}
                stroke="var(--accent)"
                strokeWidth={2}
                type="monotone"
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <EmptyChart label={emptyLabel} />
        )}
      </ChartCard>

      <ChartCard title={funnelTitle}>
        {hasFunnel ? (
          <ResponsiveContainer height={240} width="100%">
            <BarChart data={funnel}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis
                axisLine={false}
                dataKey="label"
                tickLine={false}
                tick={{ fill: 'var(--muted)', fontSize: 12 }}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={{ fill: 'var(--muted)', fontFamily: 'var(--font-geist-mono)', fontSize: 12 }}
                width={42}
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                  boxShadow: 'var(--shadow-2)',
                }}
              />
              <Bar dataKey="count" fill="var(--accent)" isAnimationActive={false} radius={8} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <EmptyChart label={emptyLabel} />
        )}
      </ChartCard>

      <ChartCard title={shopsTitle}>
        {hasShops ? (
          <ResponsiveContainer height={240} width="100%">
            <BarChart data={shops}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis
                axisLine={false}
                dataKey="name"
                tickLine={false}
                tick={{ fill: 'var(--muted)', fontSize: 12 }}
              />
              <YAxis
                axisLine={false}
                tickFormatter={compactMoney}
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
                formatter={(value) => formatMoney(Number(value), currency)}
              />
              <Bar dataKey="revenue" fill="var(--success)" isAnimationActive={false} radius={8} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <EmptyChart label={emptyLabel} />
        )}
      </ChartCard>

      <ChartCard title={agingTitle}>
        {hasAging ? (
          <ResponsiveContainer height={240} width="100%">
            <BarChart data={aging}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis
                axisLine={false}
                dataKey="driver_name"
                tickLine={false}
                tick={{ fill: 'var(--muted)', fontSize: 12 }}
              />
              <YAxis
                axisLine={false}
                tickFormatter={compactMoney}
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
                formatter={(value) => formatMoney(Number(value), currency)}
              />
              <Bar
                dataKey="bucket_lt1d"
                fill="var(--success)"
                isAnimationActive={false}
                stackId="a"
              />
              <Bar
                dataKey="bucket_1_3d"
                fill="var(--muted)"
                isAnimationActive={false}
                stackId="a"
              />
              <Bar
                dataKey="bucket_gt3d"
                fill="var(--danger)"
                isAnimationActive={false}
                radius={8}
                stackId="a"
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
