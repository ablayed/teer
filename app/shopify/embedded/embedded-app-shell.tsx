import type { ShopifyAppConfig } from '@/lib/shopify/app-registry';
import { buildShopifyEmbeddedAppUrl } from '@/lib/shopify/embedded-host';
import { redirect } from 'next/navigation';
import Script from 'next/script';
import { EmbeddedShopifySurface } from './embedded-shopify-surface';

type EmbeddedAppShellProps = {
  app: ShopifyAppConfig | null;
  host: string | undefined;
  embedded: string | undefined;
  supportEmail: string | null;
  appLabel?: string;
};

// Porte embarquée commune aux deux surfaces (/shopify/embedded et /shopify/embedded/[appLabel]) :
// redirection 3xx vers la surface Shopify Admin canonique quand `embedded` est absent ou vaut 0
// (jamais une URL externe fournie par le client — buildShopifyEmbeddedAppUrl ne dérive que du
// `host` déjà validé + du client_id de l'app déjà résolue) ; sinon, meta App Bridge AVANT le
// script CDN (contrat officiel Shopify), App Bridge chargé en premier, puis la surface.
export function EmbeddedAppShell({
  app,
  host,
  embedded,
  supportEmail,
  appLabel,
}: EmbeddedAppShellProps) {
  if (embedded !== '1' && host && app) {
    const destination = buildShopifyEmbeddedAppUrl(host, app.clientId);
    if (destination) {
      redirect(destination);
    }
  }

  return (
    <>
      {app ? <meta name="shopify-api-key" content={app.clientId} /> : null}
      <Script
        id="shopify-app-bridge"
        src="https://cdn.shopify.com/shopifycloud/app-bridge.js"
        strategy="beforeInteractive"
      />
      <EmbeddedShopifySurface
        clientId={app?.clientId ?? null}
        host={host ?? null}
        supportEmail={supportEmail}
        appLabel={appLabel}
      />
    </>
  );
}
