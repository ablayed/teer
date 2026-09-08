import { publicEnv } from '@/lib/env';
import { getShopifyAppOrNullForEmbedded } from '@/lib/shopify/embedded';
import { EmbeddedAppShell } from './embedded-app-shell';

export const dynamic = 'force-dynamic';

type EmbeddedPageProps = {
  searchParams: Promise<{ host?: string; embedded?: string }>;
};

export default async function EmbeddedPage({ searchParams }: EmbeddedPageProps) {
  const params = await searchParams;
  const app = getShopifyAppOrNullForEmbedded();

  return (
    <EmbeddedAppShell
      app={app}
      host={params.host}
      embedded={params.embedded}
      supportEmail={publicEnv.NEXT_PUBLIC_SUPPORT_EMAIL ?? null}
    />
  );
}
