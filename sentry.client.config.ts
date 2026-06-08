// Sentry client chargé en import DYNAMIQUE : le SDK sort du bundle initial
// (chunk async) au lieu d'être livré à toutes les pages. Bénéfices :
// - pages marketing/statiques (/, /confidentialite) : le SDK n'est jamais chargé
//   ni initialisé → aucun coût main-thread (TBT).
// - autres routes : import après hydratation, hors first load et hors chemin
//   critique (petite fenêtre avant capture, acceptable).
const MARKETING_PATHS = new Set(['/', '/confidentialite']);

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
    });
  });
}
