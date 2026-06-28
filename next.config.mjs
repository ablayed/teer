import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSentryConfig } from '@sentry/nextjs';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');
const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: projectRoot,
  outputFileTracingIncludes: {
    '/api/rapport': ['./lib/pdf/fonts/*.ttf'],
  },
  reactStrictMode: true,
  serverExternalPackages: ['@react-pdf/renderer'],
  // NOTE (LOT PERF #4) : on a volontairement REJETÉ `experimental.staleTimes`.
  // Ce réglage est GLOBAL (toutes les routes dynamiques), donc `dynamic: 30` ferait
  // servir, en cross-client, une liste /commandes ou des « Exceptions à traiter »
  // périmées jusqu'à 30s — inacceptable pour un cockpit COD où la fraîcheur cash/ops
  // prime. Le « tap mort / re-clic » de #4 est réglé par le feedback tap, l'indicateur
  // pending et les squelettes loading.tsx — aucun ne sacrifie la fraîcheur. Le prefetch
  // est conservé : il charge du FRAIS (jamais du périmé). Défaut `dynamic: 0` conservé.
  // En-têtes de sécurité communs aux DEUX régimes, posés globalement (y compris sur
  // /api et les assets). Le Content-Security-Policy, lui, est par-requête/par-régime
  // et géré dans `middleware.ts` (nonce pour l'app, statique pour les pages publiques).
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
          },
        ],
      },
    ];
  },
};

const configWithIntl = withNextIntl(nextConfig);

export default withSentryConfig(configWithIntl, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: !process.env.CI,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
  disableLogger: true,
  tunnelRoute: '/monitoring',
});
