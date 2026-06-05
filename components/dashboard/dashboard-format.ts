import { formatMoney } from '@/lib/format/fcfa';

// Mono-devise : on ignore volontairement la devise stockee et on affiche
// toujours « F CFA » arrondi a l'entier (cf. formatMoney). Le parametre
// `currency` est conserve pour la compatibilite des appelants.
export function formatDashboardMoney(value: number, _currency?: string | null): string {
  return formatMoney(value);
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
