'use client';

import { Card } from '@/components/ui/card';
import { type ChartConfig, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { useIsDesktop } from '@/hooks/use-is-desktop';
import type { DashboardCashCollectedByProduct } from '@/lib/actions/dashboard';
import {
  buildCashByProductChartRows,
  formatCashByProductCompactAmount,
} from '@/lib/dashboard/cash-by-product-chart';
import type { MetricLoadState } from '@/lib/dashboard/metric-load-state';
import { formatMoney } from '@/lib/format/fcfa';
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';

type TableauCashByProductChartProps = {
  emptyLabel: string;
  errorLabel: string;
  state: MetricLoadState<DashboardCashCollectedByProduct>;
  subtitle: string;
  title: string;
};

function EmptyState({ label }: { label: string }) {
  return (
    <p className="rounded-md border border-dashed border-border bg-canvas p-4 text-sm text-muted">
      {label}
    </p>
  );
}

function ErrorState({ label }: { label: string }) {
  return (
    <p className="rounded-md border border-danger/20 bg-danger-subtle p-4 text-sm font-medium text-danger">
      {label}
    </p>
  );
}

function chartValueToNumber(value: number | string | Array<number | string>): number {
  const rawValue = Array.isArray(value) ? value[0] : value;
  const numericValue = Number(rawValue ?? 0);

  return Number.isFinite(numericValue) ? numericValue : 0;
}

function HorizontalCashByProductChart({
  chart,
  subtitle,
  title,
}: {
  chart: DashboardCashCollectedByProduct;
  subtitle: string;
  title: string;
}) {
  const isDesktop = useIsDesktop();
  const rows = buildCashByProductChartRows(chart.items, {
    maxLabelLength: isDesktop ? 38 : 24,
  });
  const chartConfig = {
    revenueMinor: {
      color: '#ee8243',
      label: title,
    },
  } satisfies ChartConfig;

  return (
    <div
      aria-label={`${title}. ${subtitle}`}
      className="h-[300px] w-full"
      data-testid="tableau-cash-by-product-chart"
    >
      <ResponsiveContainer height="100%" width="100%">
        <BarChart
          barCategoryGap={isDesktop ? '22%' : '28%'}
          data={rows}
          layout="vertical"
          margin={{ bottom: 0, left: 0, right: isDesktop ? 58 : 68, top: 4 }}
        >
          <CartesianGrid horizontal={false} stroke="var(--border)" strokeDasharray="3 3" />
          <XAxis
            axisLine={false}
            domain={[0, 'dataMax']}
            hide={!isDesktop}
            tick={{
              fill: 'var(--muted)',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
            }}
            tickFormatter={(value) => formatCashByProductCompactAmount(Number(value ?? 0))}
            tickLine={false}
            type="number"
          />
          <YAxis
            axisLine={false}
            dataKey="shortTitle"
            tick={{
              fill: 'var(--muted)',
              fontSize: 12,
            }}
            tickLine={false}
            type="category"
            width={isDesktop ? 184 : 118}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                config={chartConfig}
                indicator="dot"
                labelFormatter={(value) => {
                  const row = rows.find((item) => item.shortTitle === value);
                  return row?.title ?? String(value);
                }}
                valueFormatter={(value) => formatMoney(chartValueToNumber(value))}
              />
            }
            cursor={{ fill: 'color-mix(in oklab, #ee8243 10%, transparent)' }}
          />
          <Bar dataKey="revenueMinor" fill="#ee8243" isAnimationActive={false} maxBarSize={24}>
            <LabelList
              content={({ height, value, width, x, y }) => {
                if (
                  typeof x !== 'number' ||
                  typeof y !== 'number' ||
                  typeof width !== 'number' ||
                  typeof height !== 'number' ||
                  typeof value !== 'number'
                ) {
                  return null;
                }

                return (
                  <text
                    fill="var(--muted)"
                    fontFamily="var(--font-mono)"
                    fontSize="11"
                    textAnchor="start"
                    x={x + width + 6}
                    y={y + height / 2 + 4}
                  >
                    {formatCashByProductCompactAmount(value)}
                  </text>
                );
              }}
              dataKey="revenueMinor"
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function TableauCashByProductChart({
  emptyLabel,
  errorLabel,
  state,
  subtitle,
  title,
}: TableauCashByProductChartProps) {
  return (
    <Card className="rounded-lg" data-testid="tableau-cash-by-product-card" padding="lg">
      <div className="mb-5">
        <h2 className="text-[15px] font-semibold text-text">{title}</h2>
        <p className="mt-0.5 text-xs text-muted">{subtitle}</p>
      </div>
      {state.status === 'ready' ? (
        <HorizontalCashByProductChart chart={state.data} subtitle={subtitle} title={title} />
      ) : state.status === 'error' ? (
        <ErrorState label={errorLabel} />
      ) : (
        <EmptyState label={emptyLabel} />
      )}
    </Card>
  );
}
