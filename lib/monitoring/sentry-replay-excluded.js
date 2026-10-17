// Remplace `@sentry-internal/replay` dans le bundle CLIENT (alias webpack de next.config.mjs).
// `@sentry/browser` ré-exporte `replayIntegration` et `getReplay` depuis ce paquet ; le build ne les
// élaguait pas, et ≈ 30 kB gz de Replay étaient téléchargés sans qu'aucune intégration Replay soit
// configurée. Toute tentative d'utiliser Replay échoue ici, bruyamment, plutôt que de ne rien faire.
const excluded = () => {
  throw new Error(
    "Session Replay est exclu du bundle client (lib/monitoring/sentry-replay-excluded.js). Retirer l'alias de next.config.mjs avant d'activer replayIntegration.",
  );
};

export const replayIntegration = excluded;
export const getReplay = () => undefined;
export const replayCanvasIntegration = excluded;
