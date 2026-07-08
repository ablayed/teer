'use client';

import type * as React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';

import { type ChartConfig, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { useIsDesktop } from '@/hooks/use-is-desktop';
import { cn } from '@/lib/utils';

export const RESPONSIVE_BAR_CHART_HORIZONTAL_THRESHOLD = 6;

export function buildShortCategoryLabels(categories: string[], maxLabelLength: number): string[] {
  const counts = new Map<string, number>();

  return categories.map((category) => {
    const baseLabel = truncateChartLabel(category, maxLabelLength);
    const seenCount = counts.get(baseLabel) ?? 0;
    counts.set(baseLabel, seenCount + 1);

    if (seenCount === 0) {
      return baseLabel;
    }

    const suffix = ` ${seenCount + 1}`;
    return `${truncateChartLabel(category, Math.max(4, maxLabelLength - suffix.length))}${suffix}`;
  });
}

export function truncateChartLabel(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

export function resolveResponsiveBarChartPresentation(input: {
  categoryCount: number;
  isDesktop: boolean;
}) {
  const isHorizontalLayout = input.categoryCount > RESPONSIVE_BAR_CHART_HORIZONTAL_THRESHOLD;

  if (isHorizontalLayout) {
    return {
      barCategoryGap: input.isDesktop ? '18%' : '24%',
      chartLayout: 'vertical' as const,
      maxLabelLength: input.isDesktop ? 30 : 22,
      xAxisHeight: 32,
      yAxisWidth: input.isDesktop ? 180 : 132,
    };
  }

  return {
    barCategoryGap: input.isDesktop ? '18%' : '28%',
    chartLayout: 'horizontal' as const,
    maxLabelLength: 12,
    xAxisHeight: 84,
    yAxisWidth: 56,
  };
}

function ProductCategoryTick({
  x,
  y,
  payload,
}: {
  x?: number;
  y?: number;
  payload?: { value?: string };
}) {
  if (typeof x !== 'number' || typeof y !== 'number' || typeof payload?.value !== 'string') {
    return null;
  }

  return (
    <g transform={`translate(${x},${y})`}>
      <text dy={18} fill="var(--muted)" fontSize="12" textAnchor="end" transform="rotate(-35)">
        {payload.value}
      </text>
    </g>
  );
}

type ResponsiveBarChartDatum = {
  category: string;
  value: number;
};

type ResponsiveBarChartProps = {
  ariaLabel: string;
  axisValueFormatter?: (value: number) => string;
  className?: string;
  color?: string;
  data: ResponsiveBarChartDatum[];
  dataTestId?: string;
  tooltipValueFormatter?: (value: number) => string;
  valueLabel?: string;
};

function formatTooltipValue(
  formatter: ((value: number) => string) | undefined,
  value: number | string | Array<number | string>,
): React.ReactNode {
  const numericValue = Array.isArray(value) ? Number(value[0] ?? 0) : Number(value ?? 0);

  if (formatter) {
    return formatter(numericValue);
  }

  return new Intl.NumberFormat('fr-FR').format(numericValue);
}

export function ResponsiveBarChart({
  ariaLabel,
  axisValueFormatter,
  className,
  color = 'var(--chart-1)',
  data,
  dataTestId,
  tooltipValueFormatter,
  valueLabel = 'Valeur',
}: ResponsiveBarChartProps) {
  const isDesktop = useIsDesktop();
  const presentation = resolveResponsiveBarChartPresentation({
    categoryCount: data.length,
    isDesktop,
  });
  const isHorizontalLayout = presentation.chartLayout === 'vertical';
  const shortCategories = buildShortCategoryLabels(
    data.map((item) => item.category),
    presentation.maxLabelLength,
  );
  const chartData = data.map((item, index) => ({
    category: item.category,
    shortCategory: shortCategories[index],
    value: item.value,
  }));
  const chartConfig = {
    value: {
      color,
      label: valueLabel,
    },
  } satisfies ChartConfig;

  return (
    <div
      aria-label={ariaLabel}
      className={cn('h-[260px] w-full aspect-auto', className)}
      data-testid={dataTestId}
    >
      <ResponsiveContainer height="100%" width="100%">
        <BarChart
          barCategoryGap={presentation.barCategoryGap}
          data={chartData}
          layout={presentation.chartLayout}
          margin={{ bottom: 8, left: 0, right: 8, top: 4 }}
        >
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            axisLine={false}
            dataKey={isHorizontalLayout ? 'value' : 'shortCategory'}
            domain={isHorizontalLayout ? [0, 'dataMax'] : undefined}
            height={presentation.xAxisHeight}
            interval={isHorizontalLayout ? undefined : 0}
            minTickGap={isHorizontalLayout ? undefined : 8}
            tick={
              isHorizontalLayout ? (
                {
                  fill: 'var(--muted)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                }
              ) : (
                <ProductCategoryTick />
              )
            }
            tickFormatter={(value) => {
              if (!isHorizontalLayout) {
                return String(value);
              }

              const numericValue = Number(value ?? 0);
              return axisValueFormatter
                ? axisValueFormatter(numericValue)
                : numericValue.toLocaleString('fr-FR');
            }}
            tickLine={false}
            type={isHorizontalLayout ? 'number' : 'category'}
          />
          <YAxis
            axisLine={false}
            dataKey={isHorizontalLayout ? 'shortCategory' : undefined}
            domain={isHorizontalLayout ? undefined : [0, 'dataMax']}
            tick={{
              fill: 'var(--muted)',
              fontFamily: isHorizontalLayout ? undefined : 'var(--font-mono)',
              fontSize: 12,
            }}
            tickFormatter={(value) => {
              if (isHorizontalLayout) {
                return String(value);
              }

              const numericValue = Number(value ?? 0);
              return axisValueFormatter
                ? axisValueFormatter(numericValue)
                : numericValue.toLocaleString('fr-FR');
            }}
            tickLine={false}
            type={isHorizontalLayout ? 'category' : 'number'}
            width={presentation.yAxisWidth}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                config={chartConfig}
                indicator="dot"
                labelFormatter={(value) => String(value)}
                valueFormatter={(value) => formatTooltipValue(tooltipValueFormatter, value)}
              />
            }
            cursor={{ fill: 'color-mix(in oklab, var(--chart-1) 10%, transparent)' }}
          />
          <Bar dataKey="value" fill={color} isAnimationActive={false} radius={4}>
            {isHorizontalLayout ? null : (
              <LabelList
                className="fill-muted"
                content={({ value, x, y, width }) => {
                  if (
                    typeof x !== 'number' ||
                    typeof y !== 'number' ||
                    typeof width !== 'number' ||
                    typeof value !== 'number'
                  ) {
                    return null;
                  }

                  const label = axisValueFormatter
                    ? axisValueFormatter(value)
                    : value.toLocaleString('fr-FR');

                  return (
                    <text
                      fill="var(--muted)"
                      fontFamily="var(--font-mono)"
                      fontSize="11"
                      textAnchor="middle"
                      x={x + width / 2}
                      y={Math.max(12, y - 6)}
                    >
                      {label}
                    </text>
                  );
                }}
                dataKey="value"
                position="top"
              />
            )}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
