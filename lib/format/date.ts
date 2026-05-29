const DATE_TIME_ZONE = 'Africa/Dakar';
const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const relativeTimeFormatter = new Intl.RelativeTimeFormat('fr-FR', {
  numeric: 'auto',
  style: 'short',
});

const absoluteDateFormatter = new Intl.DateTimeFormat('fr-FR', {
  day: 'numeric',
  month: 'long',
  timeZone: DATE_TIME_ZONE,
  year: 'numeric',
});

const timeFormatter = new Intl.DateTimeFormat('fr-FR', {
  hour: '2-digit',
  hour12: false,
  minute: '2-digit',
  timeZone: DATE_TIME_ZONE,
});

const monthYearFormatter = new Intl.DateTimeFormat('fr-FR', {
  month: 'long',
  timeZone: DATE_TIME_ZONE,
  year: 'numeric',
});

function toValidDate(value: Date | string): Date {
  const date = typeof value === 'string' ? new Date(value) : value;

  if (Number.isNaN(date.getTime())) {
    throw new RangeError('formatDate: invalid date');
  }

  return date;
}

function normalizeRelativeOutput(value: string): string {
  return value.replace(/[\u00A0\u202F]/g, ' ');
}

function formatRelative(value: number, unit: Intl.RelativeTimeFormatUnit): string {
  return normalizeRelativeOutput(relativeTimeFormatter.format(value, unit));
}

export function formatDateAbsolute(value: Date | string): string {
  return absoluteDateFormatter.format(toValidDate(value));
}

export function formatDateTime(value: Date | string): string {
  const date = toValidDate(value);

  return `${formatDateAbsolute(date)} à ${timeFormatter.format(date)}`;
}

export function formatMonthYear(value: Date | string): string {
  return monthYearFormatter.format(toValidDate(value));
}

export function formatDateRelative(value: Date | string): string {
  const date = toValidDate(value);
  const diffMs = date.getTime() - Date.now();
  const absMs = Math.abs(diffMs);

  if (absMs < MINUTE_MS) {
    return "à l'instant";
  }

  if (absMs < HOUR_MS) {
    const minutes = Math.round(absMs / MINUTE_MS);
    return formatRelative(diffMs < 0 ? -minutes : minutes, 'minute');
  }

  if (absMs < DAY_MS) {
    const hours = Math.round(absMs / HOUR_MS);
    return formatRelative(diffMs < 0 ? -hours : hours, 'hour');
  }

  if (absMs <= 7 * DAY_MS) {
    const days = Math.round(absMs / DAY_MS);
    return formatRelative(diffMs < 0 ? -days : days, 'day');
  }

  return formatDateAbsolute(date);
}
