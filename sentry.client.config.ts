// Sentry client chargé en import DYNAMIQUE : le SDK sort du bundle initial
// (chunk async) au lieu d'être livré à toutes les pages. Bénéfices :
// - pages marketing/statiques (/, /confidentialite) : le SDK n'est jamais chargé
//   ni initialisé → aucun coût main-thread (TBT).
// - autres routes : import après hydratation, hors first load et hors chemin
//   critique (petite fenêtre avant capture, acceptable).
const MARKETING_PATHS = new Set(['/', '/confidentialite']);

// Signature des erreurs de recovery React consommées par le mécanisme d'hydratation
// (mismatch SSR/client) : #418/#419/#421/#425. Next.js App Router n'expose PAS de moyen
// supporté d'intercepter son `onRecoverableError` interne (câblé en dur dans
// `next/dist/client/app-index.js`, non substituable depuis le code applicatif) — il
// route ces erreurs via `window.reportError(cause)` (API standard qui émule une
// exception non interceptée, cf. `report-global-error.js`), donc elles atterrissent
// dans les gestionnaires globaux `window.onerror`/`error` déjà installés par défaut par
// `Sentry.init` (intégration GlobalHandlers). Ce `beforeSend` ne fait qu'enrichir cette
// capture déjà automatique avec un tag dédié, pour pouvoir isoler ces occurrences dans
// Sentry sans dépendre d'un hook non disponible. Mitigation documentée dans CLAUDE.md :
// prefetch={false} sur les liens de ligne `/commandes` réduit/élimine le suspect n°1
// (avalanche de prefetch RSC annulés), ce capteur garantit la preuve complète (stack +
// message intégral, démini par les sourcemaps déjà configurées dans next.config.mjs) si
// le crash survient encore malgré la mitigation.
const REACT_RECOVERABLE_ERROR_PATTERN = /Minified React error #(418|419|421|425)\b/;

if (
  typeof window !== 'undefined' &&
  process.env.NEXT_PUBLIC_SENTRY_DSN &&
  !MARKETING_PATHS.has(window.location.pathname)
) {
  void import('@sentry/nextjs').then((Sentry) => {
    Sentry.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      enabled: true,
      tracesSampleRate: 0.1,
      beforeSend(event, hint) {
        const message =
          hint.originalException instanceof Error
            ? hint.originalException.message
            : (event.exception?.values?.[0]?.value ?? '');

        if (REACT_RECOVERABLE_ERROR_PATTERN.test(message)) {
          event.tags = {
            ...event.tags,
            reactRecoverableError: true,
            mitigation: 'orders-hydration-crash-b84',
          };
          event.extra = {
            ...event.extra,
            pathname: window.location.pathname,
            search: window.location.search,
          };
        }

        return event;
      },
    });
  });
}
