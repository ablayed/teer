import { AnalyticsProvider } from '@/components/analytics-provider';
import { ServiceWorkerRegister } from '@/components/service-worker-register';
import { env } from '@/lib/env';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { Metadata, Viewport } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';
import { Fraunces } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

// Serif éditorial de marque. Variable (opsz/wght), latin (couvre é/è/ë),
// roman + italique (l'italique sert les mots d'accent). Preload du poids hero.
const fraunces = Fraunces({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-fraunces',
  preload: true,
});

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
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const messages = await getMessages();

  return (
    <html lang="fr-SN" className={fraunces.variable}>
      <body className={`${GeistSans.variable} ${GeistMono.variable} min-h-dvh bg-canvas`}>
        <AnalyticsProvider />
        <ServiceWorkerRegister />
        <NextIntlClientProvider messages={messages}>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
