import { publicEnv } from '@/lib/env';
import { getShopifyAppOrNullForEmbedded } from '@/lib/shopify/embedded';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { EmbeddedAppShell } from '../embedded-app-shell';

export const dynamic = 'force-dynamic';

type EmbeddedAppPageProps = {
  params: Promise<{ appLabel: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function toSearchParams(query: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else if (value !== undefined) {
      params.append(key, value);
    }
  }
  return params;
}

export default async function EmbeddedAppPage({ params, searchParams }: EmbeddedAppPageProps) {
  const { appLabel } = await params;
  const query = await searchParams;
  const embedded = typeof query.embedded === 'string' ? query.embedded : undefined;
  const host = typeof query.host === 'string' ? query.host : undefined;

  if (embedded !== '1') {
    // SHOPIFY-OAUTH-FIRST-01 / B1 — entrée `application_url` hors de l'iframe. Aucune décision,
    // aucun rendu ici : la requête signée par Shopify est transmise telle quelle (paramètres
    // dupliqués compris, pour que le refus reste celui de la vérification) au route handler, seul
    // endroit où Next.js permet de poser le cookie de state avant la redirection vers Shopify
    // (app/api/shopify/entry/[appLabel]/route.ts).
    redirect(`/api/shopify/entry/${encodeURIComponent(appLabel)}?${toSearchParams(query)}`);
  }

  const app = getShopifyAppOrNullForEmbedded(appLabel);
  const nonce = (await headers()).get('x-nonce');

  return (
    <EmbeddedAppShell
      app={app}
      host={host}
      embedded={embedded}
      supportEmail={publicEnv.NEXT_PUBLIC_SUPPORT_EMAIL ?? null}
      nonce={nonce}
      appLabel={appLabel}
    />
  );
}
