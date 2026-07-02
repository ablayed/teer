export type PeriodPreset = 'today' | 'yesterday' | '7j' | '30j' | '90j' | 'month';
export type ActivePeriod = PeriodPreset | 'custom';

// Ordre d'affichage canonique du PeriodPicker (tokens URL inchangés — cf. décision
// ticket : zéro rupture de compat, on garde 7j/30j/90j et on AJOUTE month/custom).
export const PERIOD_PRESETS: readonly PeriodPreset[] = [
  'today',
  'yesterday',
  '7j',
  '30j',
  '90j',
  'month',
];

export function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

export function startOfMonth(date: Date): Date {
  const next = new Date(date);
  next.setDate(1);
  next.setHours(0, 0, 0, 0);
  return next;
}

export function endOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(23, 59, 59, 999);
  return next;
}

export function parseDateInput(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }

  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function toDateInput(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function resolvePeriodRange({
  allowedPresets,
  defaultPreset,
  from,
  period,
  to,
}: {
  allowedPresets: readonly PeriodPreset[];
  defaultPreset: PeriodPreset;
  from?: string;
  period?: string;
  to?: string;
}): { activePeriod: ActivePeriod; from: Date; to: Date } {
  const now = new Date();
  const customFrom = parseDateInput(from);
  const customTo = parseDateInput(to);

  if (customFrom && customTo) {
    return { activePeriod: 'custom', from: customFrom, to: endOfDay(customTo) };
  }

  const preset = allowedPresets.includes(period as PeriodPreset)
    ? (period as PeriodPreset)
    : defaultPreset;

  if (preset === 'today') {
    return { activePeriod: 'today', from: startOfDay(now), to: now };
  }

  if (preset === 'yesterday') {
    const yesterday = startOfDay(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return { activePeriod: 'yesterday', from: yesterday, to: endOfDay(yesterday) };
  }

  if (preset === 'month') {
    return { activePeriod: 'month', from: startOfMonth(now), to: now };
  }

  const days = preset === '7j' ? 7 : preset === '90j' ? 90 : 30;
  const start = startOfDay(now);
  start.setDate(start.getDate() - (days - 1));

  return { activePeriod: preset, from: start, to: now };
}
