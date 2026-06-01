export function formatDashboardMoney(value: number, currency: string | null | undefined): string {
  return new Intl.NumberFormat('fr-FR', {
    currency: currency?.trim().toUpperCase() || 'XOF',
    style: 'currency',
  }).format(value);
}

export function formatDashboardCount(value: number): string {
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(value);
}

export function formatOrderNumber(value: string | null, emptyLabel: string): string {
  if (!value) {
    return emptyLabel;
  }

  return value.startsWith('#') ? value : `#${value}`;
}
