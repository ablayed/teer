import { sanitizePostHogEvent } from '@/lib/security/telemetry-sanitize';

// PostHog hors du chemin initial (V1). `posthog-js` pèse ≈ 190 kB de source (≈ 60 kB gz) : un import
// statique le téléchargeait et l'évaluait avant que la page soit utilisable, même sans clé valide.
// Il est maintenant importé dynamiquement, APRÈS le chargement de la page et pendant un temps
// mort du navigateur, et jamais sans clé.
//
// Aucun appel `posthog.capture` n'existe dans l'application : le seul événement est la vue de page
// que PostHog émet lui-même à son initialisation (`capture_pageview`). Il n'y a donc aucune file
// d'attente d'événements à vider : rien n'est capturé avant que le SDK soit prêt. Si une capture
// applicative est ajoutée un jour, elle devra passer par une file locale vidée à l'initialisation.
//
// Un import statique de `posthog-js` ailleurs que pour un type est interdit :
// tests/unit/analytics/posthog-deferred.test.ts le verrouille.

let scheduled = false;

// Délai maximal avant de lancer le chargement quand le navigateur n'a jamais de temps mort.
const IDLE_TIMEOUT_MS = 5_000;
// Repli sans `requestIdleCallback` (Safari avant 18) : après le chargement, une petite pause.
const FALLBACK_DELAY_MS = 2_000;

function afterLoadAndIdle(callback: () => void) {
  const schedule = () => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(callback, { timeout: IDLE_TIMEOUT_MS });
    } else {
      window.setTimeout(callback, FALLBACK_DELAY_MS);
    }
  };
  if (document.readyState === 'complete') {
    schedule();
  } else {
    window.addEventListener('load', schedule, { once: true });
  }
}

export function initPostHog() {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;

  // Pas de clé : rien n'est chargé du tout.
  if (scheduled || !key) {
    return;
  }
  scheduled = true;

  afterLoadAndIdle(() => {
    void import('posthog-js')
      .then(({ default: posthog }) => {
        posthog.init(key, {
          api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
          capture_pageview: true,
          before_send: sanitizePostHogEvent,
        });
      })
      .catch(() => {
        // L'analytics ne bloque jamais l'application : un échec de chargement est silencieux.
      });
  });
}
