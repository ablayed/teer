import { AnalyticsProvider } from '@/components/analytics-provider';
import { ServiceWorkerRegister } from '@/components/service-worker-register';
import { env } from '@/lib/env';
import messages from '@/messages/fr.json';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(env.NEXT_PUBLIC_APP_URL),
  title: 'Tëër',
  description: messages.marketing.hero.subtitle,
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  },
};

export const viewport: Viewport = {
  themeColor: '#F4F3ED',
  colorScheme: 'light',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr-SN">
      <body className={`${GeistSans.variable} ${GeistMono.variable} min-h-dvh bg-canvas`}>
        <AnalyticsProvider />
        <ServiceWorkerRegister />
        {children}
      </body>
    </html>
  );
}
