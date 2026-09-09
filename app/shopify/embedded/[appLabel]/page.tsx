import { publicEnv } from '@/lib/env';
import { getShopifyAppOrNullForEmbedded } from '@/lib/shopify/embedded';
import { headers } from 'next/headers';
import { EmbeddedAppShell } from '../embedded-app-shell';

export const dynamic = 'force-dynamic';

type EmbeddedAppPageProps = {
  params: Promise<{ appLabel: string }>;
  searchParams: Promise<{ host?: string; embedded?: string }>;
};

export default async function EmbeddedAppPage({ params, searchParams }: EmbeddedAppPageProps) {
  const { appLabel } = await params;
  const query = await searchParams;
  const app = getShopifyAppOrNullForEmbedded(appLabel);
  const nonce = (await headers()).get('x-nonce');

  return (
    <EmbeddedAppShell
      app={app}
      host={query.host}
      embedded={query.embedded}
      supportEmail={publicEnv.NEXT_PUBLIC_SUPPORT_EMAIL ?? null}
      nonce={nonce}
      appLabel={appLabel}
    />
  );
}
