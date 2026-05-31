'use client';

import { formatFCFA } from '@/lib/format/fcfa';
import { cn } from '@/lib/utils';
import React, { useEffect, useId, useMemo, useState } from 'react';
import { Area, AreaChart, ResponsiveContainer } from 'recharts';

type KPIUnit = 'XOF' | '%' | 'count';
type DeltaType = 'pct' | 'abs';
type AccentColor = 'default' | 'warning' | 'success' | 'danger';

export type KPISparklinePoint = {
  date: string;
  value: number;
};

export type KPICardProps = {
  label: string;
  value: string | number;
  unit?: KPIUnit;
  deltaPct?: number;
  deltaAbs?: number;
  deltaType?: DeltaType;
  sparkline?: KPISparklinePoint[];
  loading?: boolean;
  accentColor?: AccentColor;
  invertDelta?: boolean;
  error?: boolean;
  errorLabel?: string;
};

const accentStyles = {
  default: 'border-border bg-surface',
  warning: 'border-warning/30 bg-amber-50',
  success: 'border-success/30 bg-green-50',
  danger: 'border-danger/30 bg-red-50',
} satisfies Record<AccentColor, string>;

function formatPct(value: number): string {
  return new Intl.NumberFormat('fr-FR', {
    maximumFractionDigits: 1,
    minimumFractionDigits: Number.isInteger(value) ? 0 : 1,
  })
    .format(value)
    .concat(' %');
}

function formatValue(value: string | number, unit: KPIUnit): string {
  if (typeof value === 'string') {
    return value;
  }

  if (unit === 'XOF') {
    return formatFCFA(value);
  }

  if (unit === '%') {
    return formatPct(value);
  }

  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(Math.round(value));
}

function useCountUp(value: string | number, loading: boolean | undefined): string | number {
  const numericValue = typeof value === 'number' ? value : null;
  const [displayValue, setDisplayValue] = useState<number | string>(() => {
    if (numericValue === null || loading) {
      return value;
    }

    return 0;
  });

  useEffect(() => {
    if (numericValue === null || loading) {
      setDisplayValue(value);
      return;
    }

    const targetValue = numericValue;
    const duration = 800;
    const startedAt = performance.now();
    let frameId = 0;

    function tick(now: number) {
      const progress = Math.min((now - startedAt) / duration, 1);
      setDisplayValue(Math.round(targetValue * progress));

      if (progress < 1) {
        frameId = requestAnimationFrame(tick);
      }
    }

    frameId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [loading, numericValue, value]);

  return displayValue;
}

function DeltaChip({
  deltaAbs,
  deltaPct,
  deltaType,
  invertDelta,
}: Pick<KPICardProps, 'deltaAbs' | 'deltaPct' | 'deltaType' | 'invertDelta'>) {
  const delta = deltaType === 'abs' ? deltaAbs : deltaPct;

  if (delta === undefined || delta === 0) {
    return null;
  }

  const isPositive = delta > 0;
  const isGood = invertDelta ? !isPositive : isPositive;
  const arrow = isPositive ? '↑' : '↓';
  const formattedDelta =
    deltaType === 'abs'
      ? `${isPositive ? '+' : ''}${new Intl.NumberFormat('fr-FR').format(delta)}`
      : `${isPositive ? '+' : ''}${formatPct(delta)}`;

  return (
    <span
      className={cn(
        'inline-flex h-7 items-center gap-1 rounded-full border px-2 text-xs font-semibold',
        isGood
          ? 'border-success/20 bg-green-50 text-success'
          : 'border-danger/20 bg-red-50 text-danger',
      )}
      data-kpi-delta-tone={isGood ? 'positive' : 'negative'}
    >
      <span aria-hidden="true">{arrow}</span>
      {formattedDelta}
    </span>
  );
}

export function KPICard({
  accentColor = 'default',
  deltaAbs,
  deltaPct,
  deltaType = 'pct',
  error = false,
  errorLabel,
  invertDelta = false,
  label,
  loading = false,
  sparkline,
  unit = 'count',
  value,
}: KPICardProps) {
  const gradientId = useId().replace(/:/g, '');
  const animatedValue = useCountUp(value, loading);
  const formattedValue = error ? '—' : formatValue(animatedValue, unit);
  const chartData = useMemo(() => sparkline ?? [], [sparkline]);

  return (
    <output
      aria-busy={loading}
      aria-label={`${label}: ${formattedValue}`}
      className={cn(
        'min-h-[164px] rounded-lg border p-4 shadow-1',
        'flex flex-col justify-between gap-3',
        accentStyles[accentColor],
      )}
      title={error ? errorLabel : undefined}
    >
      <div className="space-y-2">
        <p className="text-sm font-medium text-muted">{label}</p>
        {loading ? (
          <div
            className="h-11 w-32 animate-pulse rounded-md bg-border"
            data-testid="kpi-value-skeleton"
          />
        ) : (
          <p className="font-mono text-[36px] leading-none text-text">{formattedValue}</p>
        )}
      </div>

      {chartData.length > 0 && !loading ? (
        <div className="h-16 w-full" data-testid="kpi-sparkline">
          <ResponsiveContainer height="100%" width="100%">
            <AreaChart data={chartData} margin={{ bottom: 0, left: 0, right: 0, top: 4 }}>
              <defs>
                <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="#EE8243" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#EE8243" stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area
                dataKey="value"
                fill={`url(#${gradientId})`}
                isAnimationActive={false}
                stroke="#EE8243"
                strokeWidth={2}
                type="monotone"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : null}

      {loading ? (
        <div
          className="h-7 w-20 animate-pulse rounded-full bg-border"
          data-testid="kpi-delta-skeleton"
        />
      ) : (
        <DeltaChip
          deltaAbs={deltaAbs}
          deltaPct={deltaPct}
          deltaType={deltaType}
          invertDelta={invertDelta}
        />
      )}
    </output>
  );
}
