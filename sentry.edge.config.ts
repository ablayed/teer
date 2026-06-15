import * as Sentry from '@sentry/nextjs';

// Voir sentry.server.config.ts : désactivé en E2E prod-build pour éviter le flush réseau
// bloquant au teardown du webServer Playwright.
const sentryEnabled =
  Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN) && process.env.E2E_PROD_BUILD !== '1';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: sentryEnabled,
  tracesSampleRate: 0.1,
});
