import { publicEnv } from '@/lib/env';
import { getShopifyAppOrNullForEmbedded } from '@/lib/shopify/embedded';
import Script from 'next/script';
import type { ReactNode } from 'react';
import { EmbeddedShopifySurface } from '../embedded-shopify-surface';

export const dynamic = 'force-dynamic';

type EmbeddedAppPageProps = {
  params: Promise<{ appLabel: string }>;
  searchParams: Promise<{ host?: string }>;
};

export default async function EmbeddedAppPage({ params, searchParams }: EmbeddedAppPageProps) {
  const { appLabel } = await params;
  const query = await searchParams;
  const app = getShopifyAppOrNullForEmbedded(appLabel);
  const appBridgeScript: ReactNode = (
    <Script
      id="shopify-app-bridge"
      src="https://cdn.shopify.com/shopifycloud/app-bridge.js"
      strategy="beforeInteractive"
    />
  );

  return (
    <>
      {appBridgeScript}
      <EmbeddedShopifySurface
        appLabel={appLabel}
        clientId={app?.clientId ?? null}
        host={query.host ?? null}
        supportEmail={publicEnv.NEXT_PUBLIC_SUPPORT_EMAIL ?? null}
      />
    </>
  );
}
