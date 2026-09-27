import { publicEnv } from '@/lib/env';
import { getShopifyAppByLabel } from '@/lib/shopify/apps';
import { getShopifyAppOrNullForEmbedded } from '@/lib/shopify/embedded';
import { signShopifyNonEmbeddedInstallIntent } from '@/lib/shopify/non-embedded-install-intent';
import { validateShopDomain, verifyOAuthHmac } from '@/lib/shopify/oauth';
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

function refusal(message: string, code: string) {
  return (
    <main className="mx-auto max-w-md px-4 py-16 text-center" data-error={code}>
      <h1 className="font-display text-2xl">Installation Shopify refusée</h1>
      <p className="mt-3 text-sm text-muted">{message}</p>
    </main>
  );
}

export default async function EmbeddedAppPage({ params, searchParams }: EmbeddedAppPageProps) {
  const { appLabel } = await params;
  const query = await searchParams;
  const embedded = typeof query.embedded === 'string' ? query.embedded : undefined;
  const host = typeof query.host === 'string' ? query.host : undefined;

  if (embedded !== '1') {
    const app = getShopifyAppByLabel(appLabel);
    if (!app) return refusal('Cette application Shopify est inconnue.', 'unknown_app_label');

    const signedQuery = toSearchParams(query);
    const hmac = signedQuery.getAll('hmac');
    const shopValues = signedQuery.getAll('shop');
    const timestampValues = signedQuery.getAll('timestamp');
    const shop = shopValues[0]?.trim() ?? '';
    const timestamp = Number(timestampValues[0]);
    const timestampFresh =
      Number.isSafeInteger(timestamp) && Math.abs(Date.now() / 1000 - timestamp) <= 5 * 60;

    if (
      hmac.length !== 1 ||
      shopValues.length !== 1 ||
      timestampValues.length !== 1 ||
      !timestampFresh ||
      !validateShopDomain(shop) ||
      !verifyOAuthHmac(signedQuery, app.clientSecret)
    ) {
      return refusal(
        'La signature de cette entrée Shopify est invalide ou expirée.',
        'invalid_hmac',
      );
    }

    const intent = signShopifyNonEmbeddedInstallIntent(
      { appLabel: app.label, shop },
      app.clientSecret,
    );
    redirect(`/api/shopify/non-embedded-intent?intent=${encodeURIComponent(intent)}`);
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
