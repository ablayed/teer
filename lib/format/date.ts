const relativeTimeFormatter = new Intl.RelativeTimeFormat('fr-FR', {
  numeric: 'auto',
  style: 'short',
});

const absoluteDateFormatter = new Intl.DateTimeFormat('fr-FR', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Africa/Dakar',
});

function formatRelative(value: number, unit: Intl.RelativeTimeFormatUnit) {
  return relativeTimeFormatter.format(value, unit).replace(/\u00A0/g, ' ');
}

export function formatDateRelative(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  const diffMs = date.getTime() - Date.now();
  const absMs = Math.abs(diffMs);
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (absMs < hourMs) {
    const minutes = Math.max(1, Math.round(absMs / minuteMs));
    return formatRelative(diffMs < 0 ? -minutes : minutes, 'minute');
  }

  if (absMs < dayMs) {
    const hours = Math.max(1, Math.round(absMs / hourMs));
    return formatRelative(diffMs < 0 ? -hours : hours, 'hour');
  }

  if (absMs <= 7 * dayMs) {
    const days = Math.max(1, Math.round(absMs / dayMs));
    return formatRelative(diffMs < 0 ? -days : days, 'day');
  }

  return absoluteDateFormatter.format(date);
}
