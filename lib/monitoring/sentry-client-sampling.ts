// Taux d'échantillonnage des transactions du client Sentry.
//
// Module pur, sans `env` : le taux des CHARGEMENTS de page (pageload, seuls porteurs de LCP/TTFB/FCP/
// CLS) se règle par `NEXT_PUBLIC_SENTRY_PAGELOAD_SAMPLE_RATE`, inliné à la compilation (un changement
// exige un redéploiement). Toute autre transaction client garde le taux fixe.

export const DEFAULT_PAGELOAD_SAMPLE_RATE = 0.1;
export const OTHER_TRANSACTIONS_SAMPLE_RATE = 0.1;

/** Un taux entre 0 et 1 inclus ; toute autre valeur (absente, vide, non numérique, hors bornes) donne le défaut. */
export function resolvePageloadSampleRate(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PAGELOAD_SAMPLE_RATE;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) return DEFAULT_PAGELOAD_SAMPLE_RATE;
  return value;
}

type SamplingContext = { attributes?: Record<string, unknown> | undefined };

export function clientTracesSampler(pageloadRate: number): (context: SamplingContext) => number {
  return (context) =>
    context.attributes?.['sentry.op'] === 'pageload'
      ? pageloadRate
      : OTHER_TRANSACTIONS_SAMPLE_RATE;
}
