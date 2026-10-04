import * as Sentry from '@sentry/nextjs';
import { sanitizeSentryEvent, sanitizeSentryTransaction } from './lib/security/telemetry-sanitize';

// Voir sentry.server.config.ts : désactivé en E2E prod-build pour éviter le flush réseau
// bloquant au teardown du webServer Playwright.
const sentryEnabled =
  Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN) && process.env.E2E_PROD_BUILD !== '1';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: sentryEnabled,
  tracesSampleRate: 0.1,
  beforeSend: (event) => sanitizeSentryEvent(event),
  // Les transactions ne passent pas par `beforeSend` : sans ceci, l'URL brute d'une requête
  // d'ingestion — donc le secret du jeton L3 — partait avec les traces échantillonnées.
  beforeSendTransaction: (event) => sanitizeSentryTransaction(event),
});
