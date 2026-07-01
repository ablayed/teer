'use client';

import { Sparkline } from '@/components/kpi/Sparkline';
import { DefinitionToggle } from '@/components/ui/definition-card';
import { formatFCFA } from '@/lib/format/fcfa';
import { cn } from '@/lib/utils';
import { animate, useReducedMotion } from 'framer-motion';
import React, { useEffect, useMemo, useRef } from 'react';

type KPIUnit = 'currency' | '%' | 'count';
type DeltaType = 'pct' | 'abs';
type Tone = 'default' | 'success' | 'attention' | 'warning';

export type KPISparklinePoint = {
  date: string;
  value: number;
};

export type KPICardProps = {
  label: string;
  value: number;
  unit?: KPIUnit;
  currency?: string | null;
  deltaPct?: number;
  deltaAbs?: number;
  deltaType?: DeltaType;
  sparkline?: KPISparklinePoint[];
  loading?: boolean;
  tone?: Tone;
  accentColor?: 'default' | 'warning' | 'success' | 'danger';
  invertDelta?: boolean;
  error?: boolean;
  errorLabel?: string;
  // Optionnel : explication marchand révélée au tap (libellé jargon → langage simple).
  definition?: string;
  definitionFormula?: string;
};

const toneStyles = {
  default: 'border-border bg-surface',
  success: 'border-success/20 bg-success-subtle',
  attention: 'border-accent/35 bg-surface ring-1 ring-accent/35',
  warning: 'border-accent/20 bg-accent-subtle',
} satisfies Record<Tone, string>;

function formatPct(value: number): string {
  return new Intl.NumberFormat('fr-FR', {
    maximumFractionDigits: 1,
    minimumFractionDigits: Number.isInteger(value) ? 0 : 1,
  })
    .format(value)
    .concat(' %');
}

function formatValue(value: number, unit: KPIUnit): string {
  // Mono-devise : toute valeur monetaire s'affiche en « F CFA » arrondi a l'entier.
  if (unit === 'currency') {
    return formatFCFA(value);
  }

  if (unit === '%') {
    return formatPct(value);
  }

  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(Math.round(value));
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
        'inline-flex h-7 items-center gap-1 rounded-sm border px-2 text-xs font-semibold tabular-nums',
        isGood
          ? 'border-success/20 bg-success-subtle text-success'
          : 'border-danger/20 bg-danger-subtle text-danger',
      )}
      data-kpi-delta-tone={isGood ? 'positive' : 'negative'}
    >
      <span aria-hidden="true">{arrow}</span>
      {formattedDelta}
    </span>
  );
}

function useCountUp({
  format,
  loading,
  value,
}: {
  format: (value: number) => string;
  loading: boolean;
  value: number;
}) {
  const outputRef = useRef<HTMLOutputElement>(null);
  const hasAnimated = useRef(false);
  const prefersReducedMotion = useReducedMotion();
  const formattedValue = format(value);

  useEffect(() => {
    const output = outputRef.current;

    if (!output || loading) {
      return;
    }

    if (hasAnimated.current || prefersReducedMotion) {
      output.textContent = formattedValue;
      hasAnimated.current = true;
      return;
    }

    hasAnimated.current = true;
    const controls = animate(0, value, {
      duration: 0.5,
      ease: [0.2, 0, 0, 1],
      onUpdate: (latest) => {
        output.textContent = format(latest);
      },
    });

    return () => {
      controls.stop();
    };
  }, [format, formattedValue, loading, prefersReducedMotion, value]);

  return { formattedValue, outputRef };
}

function resolveTone({ accentColor, tone }: Pick<KPICardProps, 'accentColor' | 'tone'>): Tone {
  if (tone) {
    return tone;
  }

  if (accentColor === 'success') {
    return 'success';
  }

  if (accentColor === 'warning') {
    return 'warning';
  }

  return 'default';
}

export function KPICard({
  accentColor,
  definition,
  definitionFormula,
  deltaAbs,
  deltaPct,
  deltaType = 'pct',
  error = false,
  errorLabel,
  invertDelta = false,
  label,
  loading = false,
  sparkline,
  tone,
  unit = 'count',
  value,
}: KPICardProps) {
  const cardTone = resolveTone({ accentColor, tone });
  const format = useMemo(() => (nextValue: number) => formatValue(nextValue, unit), [unit]);
  const { formattedValue, outputRef } = useCountUp({ format, loading: loading || error, value });
  const chartData = useMemo(() => sparkline ?? [], [sparkline]);

  return (
    <article
      className={cn(
        '@container min-h-[164px] rounded-md border p-4 shadow-1 transition duration-200 ease-standard md:p-6 md:hover:-translate-y-0.5 md:hover:shadow-2',
        'flex flex-col justify-between gap-4',
        toneStyles[cardTone],
      )}
      title={error ? errorLabel : undefined}
    >
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-2">
          <p className="text-[13px] font-medium leading-snug text-muted">{label}</p>
          {definition && !loading && !error ? (
            <DefinitionToggle definition={definition} formula={definitionFormula} />
          ) : null}
        </div>
        {loading ? (
          <div
            className="dashboard-shimmer h-10 w-32 rounded-sm md:h-11"
            data-testid="kpi-value-skeleton"
          />
        ) : (
          <div className="w-full overflow-hidden">
            <output
              aria-label={`${label}: ${error ? 'Indisponible' : formattedValue}`}
              className="block whitespace-nowrap font-mono text-[clamp(1.5rem,4cqw,2.25rem)] leading-none text-text tabular-nums @max-[13rem]:text-[clamp(1rem,6cqw,1.5rem)]"
              ref={outputRef}
            >
              {error ? '—' : formattedValue}
            </output>
          </div>
        )}
      </div>

      {chartData.length > 0 && !loading && !error ? (
        <Sparkline data={chartData} tone={cardTone === 'success' ? 'success' : 'accent'} />
      ) : null}

      {loading ? (
        <div className="dashboard-shimmer h-7 w-20 rounded-sm" data-testid="kpi-delta-skeleton" />
      ) : (
        <DeltaChip
          deltaAbs={deltaAbs}
          deltaPct={deltaPct}
          deltaType={deltaType}
          invertDelta={invertDelta}
        />
      )}
    </article>
  );
}
