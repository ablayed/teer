import type { ActivePeriod, PeriodPreset } from '@/lib/periods/date-range';
import { toDateInput } from '@/lib/periods/date-range';
import Link from 'next/link';

type PeriodControlsProps = {
  activePeriod: ActivePeriod;
  from: Date;
  labels: {
    apply: string;
    from: string;
    presets: Record<PeriodPreset, string>;
    to: string;
  };
  pathname: string;
  presets: readonly PeriodPreset[];
  searchParams: Record<string, string | undefined>;
  to: Date;
};

function buildPresetHref({
  pathname,
  period,
  searchParams,
}: {
  pathname: string;
  period: PeriodPreset;
  searchParams: Record<string, string | undefined>;
}) {
  const next = new URLSearchParams();

  for (const [key, value] of Object.entries(searchParams)) {
    if (!value || key === 'period' || key === 'from' || key === 'to') {
      continue;
    }
    next.set(key, value);
  }

  next.set('period', period);
  return `${pathname}?${next.toString()}`;
}

export function PeriodControls({
  activePeriod,
  from,
  labels,
  pathname,
  presets,
  searchParams,
  to,
}: PeriodControlsProps) {
  return (
    <form className="flex flex-wrap items-end gap-2" method="get">
      {Object.entries(searchParams).map(([key, value]) =>
        value && key !== 'period' && key !== 'from' && key !== 'to' ? (
          <input key={key} name={key} type="hidden" value={value} />
        ) : null,
      )}
      <div className="flex rounded-lg border border-border bg-surface p-1 shadow-1">
        {presets.map((period) => (
          <Link
            aria-current={activePeriod === period ? 'true' : undefined}
            className={`grid min-h-11 place-items-center rounded-md px-3 text-sm font-medium ${
              activePeriod === period ? 'bg-accent text-text' : 'text-muted hover:text-text'
            }`}
            href={buildPresetHref({ pathname, period, searchParams })}
            key={period}
          >
            {labels.presets[period]}
          </Link>
        ))}
      </div>
      <label className="space-y-1 text-xs font-medium text-muted">
        {labels.from}
        <input
          className="block h-11 rounded-md border border-border bg-surface px-3 text-sm text-text"
          defaultValue={toDateInput(from)}
          name="from"
          type="date"
        />
      </label>
      <label className="space-y-1 text-xs font-medium text-muted">
        {labels.to}
        <input
          className="block h-11 rounded-md border border-border bg-surface px-3 text-sm text-text"
          defaultValue={toDateInput(to)}
          name="to"
          type="date"
        />
      </label>
      <button
        className="min-h-11 rounded-md bg-accent px-4 text-sm font-semibold text-text hover:bg-accent-hover"
        type="submit"
      >
        {labels.apply}
      </button>
    </form>
  );
}
