import * as Sentry from '@sentry/nextjs';
import { sanitizeSentryEvent } from './lib/security/telemetry-sanitize';
import { sanitizeSentryServerTransaction } from './lib/security/telemetry-sanitize-server';

// Voir sentry.server.config.ts : désactivé en E2E prod-build pour éviter le flush réseau
// bloquant au teardown du webServer Playwright.
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
