import * as Sentry from '@sentry/nextjs';

export async function register() {
  // V11 — mesure TEMPORAIRE par appel des requêtes vers Supabase. Indépendante de Sentry (dont les
  // traces serveur restent suspendues) : sans le drapeau, le module n'est jamais chargé.
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.V11_SUPABASE_TRACE === '1') {
    const { installSupabaseCallTraceFromEnvironment } = await import(
      './lib/monitoring/supabase-call-trace-runtime'
    );
    installSupabaseCallTraceFromEnvironment();
  }

  if (process.env.NEXT_PUBLIC_SENTRY_DSN && process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
    // Alerte si la prod Vercel tourne sans les env du rate-limit auth (fail-open
    // silencieux sinon). Runtime nodejs uniquement → une seule émission au boot.
    const { reportAuthRateLimitConfigAtBoot } = await import('./lib/security/auth-rate-limit');
    reportAuthRateLimitConfigAtBoot();
  }

  if (process.env.NEXT_PUBLIC_SENTRY_DSN && process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

export const onRequestError = Sentry.captureRequestError;
