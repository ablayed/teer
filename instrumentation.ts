import * as Sentry from '@sentry/nextjs';

export async function register() {
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
