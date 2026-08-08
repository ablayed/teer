import { publicEnv } from '@/lib/env';
import { getShopifyAppOrNullForEmbedded } from '@/lib/shopify/embedded';
import Script from 'next/script';
import type { ReactNode } from 'react';
import { EmbeddedShopifySurface } from './embedded-shopify-surface';

export const dynamic = 'force-dynamic';

type EmbeddedPageProps = {
  searchParams: Promise<{ host?: string }>;
};

export default async function EmbeddedPage({ searchParams }: EmbeddedPageProps) {
  const params = await searchParams;
  const app = getShopifyAppOrNullForEmbedded();
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
        clientId={app?.clientId ?? null}
        host={params.host ?? null}
        supportEmail={publicEnv.NEXT_PUBLIC_SUPPORT_EMAIL ?? null}
      />
    </>
  );
}
