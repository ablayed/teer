'use client';

import { useEffect, useState } from 'react';

// error.tsx (App Router error boundary) NE PEUT PAS rattraper ce crash. Constat vérifié
// en lisant les sources Next.js (`next/dist/client/react-client-callbacks/on-recoverable-error.js`
// + `report-global-error.js`) : une erreur de RECOVERY React (#418/#419/#421/#425, mismatch
// hydratation) est par construction une erreur que React a DÉJÀ « récupérée » (démontage +
// remontage client réussis) — elle n'est jamais renvoyée dans l'arbre de composants comme une
// exception de rendu, donc `getDerivedStateFromError`/`componentDidCatch` (le mécanisme dont
// dépend error.tsx) n'est jamais invoqué pour elle. Next.js la route directement vers
// `window.reportError(cause)`, une API qui émule une exception NON interceptée au niveau
// window — hors du chemin synchrone que surveille un error boundary React.
// Ce composant est donc un filet best-effort au niveau window, pas un vrai remplacement
// d'error boundary : il ne peut qu'informer l'utilisateur après coup, jamais empêcher le gel
// silencieux observé en prod. Capture Sentry déjà assurée séparément (sentry.client.config.ts,
// GlobalHandlers + tag `reactRecoverableError`) — ce composant ne fait qu'afficher un signal UI.
const REACT_RECOVERABLE_ERROR_PATTERN = /Minified React error #(418|419|421|425)\b/;

export function HydrationCrashRecoveryBanner() {
  const [detected, setDetected] = useState(false);

  useEffect(() => {
    function handleWindowError(event: ErrorEvent) {
      const message = event.error instanceof Error ? event.error.message : event.message;

      if (REACT_RECOVERABLE_ERROR_PATTERN.test(message ?? '')) {
        setDetected(true);
      }
    }

    window.addEventListener('error', handleWindowError);
    return () => window.removeEventListener('error', handleWindowError);
  }, []);

  if (!detected) {
    return null;
  }

  return (
    <div
      className="fixed inset-x-3 bottom-[calc(var(--mobile-nav-reserved-height,0px)_+_12px)] z-50 flex items-center justify-between gap-3 rounded-lg border border-danger/30 bg-surface px-4 py-3 text-sm shadow-warm-3 md:inset-x-auto md:right-6 md:max-w-sm"
      role="alert"
    >
      <span className="text-text">Une erreur est survenue. Rechargez la page.</span>
      <button
        className="min-h-9 shrink-0 rounded-md bg-danger px-3 text-sm font-semibold text-white hover:opacity-90"
        onClick={() => window.location.reload()}
        type="button"
      >
        Recharger
      </button>
    </div>
  );
}
