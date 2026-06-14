import { withSentryConfig } from '@sentry/nextjs';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingIncludes: {
    '/api/rapport': ['./lib/pdf/fonts/*.ttf'],
  },
  reactStrictMode: true,
  serverExternalPackages: ['@react-pdf/renderer'],
  // Router Cache (LOT PERF #4) : par défaut `dynamic = 0` → chaque navigation (y compris
  // retour arrière) re-fetch la page depuis fra1, ce qui est très perceptible en 4G Dakar.
  // On garde un cache court côté client : 30s sur les pages dynamiques, 180s sur le préfetch
  // statique. Les mutations appellent toujours `revalidatePath`, qui invalide ce cache pour
  // le chemin concerné → la fraîcheur passive reste bornée à 30s (acceptable pour la liste).
  experimental: {
    staleTimes: {
      dynamic: 30,
      static: 180,
    },
  },
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
