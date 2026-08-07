import { env } from '@/lib/env';
import '@fontsource-variable/fraunces/wght.css';
import '@fontsource-variable/fraunces/wght-italic.css';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { Metadata, Viewport } from 'next';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const common = await getTranslations('common');
  const hero = await getTranslations('marketing.hero');

  return {
    metadataBase: new URL(env.NEXT_PUBLIC_APP_URL),
    title: common('appName'),
    description: hero('subtitle'),
    manifest: '/manifest.webmanifest',
    icons: {
      icon: [
        { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    },
  };
}

export const viewport: Viewport = {
  themeColor: '#F4F3ED',
  colorScheme: 'light',
  // Requis pour que `env(safe-area-inset-*)` soit non nul (notch / home indicator iOS).
  // Sans `cover`, les safe-areas déjà câblées (app-shell, bottom nav) valent 0.
  viewportFit: 'cover',
};

// Le root layout reste 100 % Server Component, sans provider client : la landing
// n'hydrate aucun contexte applicatif. Le NextIntlClientProvider (i18n côté
// client) est fourni uniquement par les routes qui en ont besoin : (app),
// /connexion, /onboarding. Les Server Components lisent l'i18n via getTranslations.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr-SN">
      <body className={`${GeistSans.variable} ${GeistMono.variable} min-h-dvh bg-canvas`}>
        {children}
      </body>
    </html>
  );
}
