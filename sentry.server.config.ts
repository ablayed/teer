import * as Sentry from '@sentry/nextjs';
import { sanitizeSentryEvent } from './lib/security/telemetry-sanitize';
import { sanitizeSentryServerTransaction } from './lib/security/telemetry-sanitize-server';

// Sentry désactivé pendant les E2E prod-build (`E2E_PROD_BUILD=1`) : `next start` charge
// `.env.local` au runtime (qui porte le DSN en local) → le SDK tente un flush réseau au
// teardown → réseau interdit → la fermeture du webServer Playwright pend jusqu'au timeout.
// Le process `pnpm start` hérite de `E2E_PROD_BUILD` du runner Playwright. En CI le DSN est
// déjà absent du build ; ce garde rend le comportement déterministe en local ET en CI.
const sentryEnabled =
  Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN) && process.env.E2E_PROD_BUILD !== '1';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: sentryEnabled,
  // Traces serveur suspendues : un échantillonneur qui rend toujours 0 l'emporte aussi sur la décision
  // d'échantillonnage héritée d'un en-tête `sentry-trace` entrant (le client en émet à 10 %).
  tracesSampler: () => 0,
  beforeSend: (event) => sanitizeSentryEvent(event),
  // Les transactions ne passent pas par `beforeSend` : elles sont reconstruites par liste blanche
  // (méthode, route paramétrée, spans techniques), jamais transmises telles quelles.
  beforeSendTransaction: (event) => sanitizeSentryServerTransaction(event),
});
