import type { ShopifyAppConfig } from '@/lib/shopify/app-registry';
import { buildShopifyEmbeddedAppUrl } from '@/lib/shopify/embedded-host';
import { redirect } from 'next/navigation';
import { EmbeddedShopifySurface } from './embedded-shopify-surface';

type EmbeddedAppShellProps = {
  app: ShopifyAppConfig | null;
  host: string | undefined;
  embedded: string | undefined;
  supportEmail: string | null;
  appLabel?: string;
  /** Nonce CSP de la requête (régime « embedded » = nonce + 'strict-dynamic'). */
  nonce?: string | null;
};

// Porte embarquée commune aux deux surfaces (/shopify/embedded et /shopify/embedded/[appLabel]) :
// redirection 3xx vers la surface Shopify Admin canonique quand `embedded` est absent ou vaut 0
// (jamais une URL externe fournie par le client — buildShopifyEmbeddedAppUrl ne dérive que du
// `host` déjà validé + du client_id de l'app déjà résolue) ; sinon, meta App Bridge AVANT le
// script CDN (contrat officiel Shopify), App Bridge avant la surface.
//
// Le tag App Bridge est un <script> BRUT, JAMAIS `next/script` : avec `strategy="beforeInteractive"`
// l'App Router n'émet aucun <script> dans le HTML servi (un <link rel=preload> plus une poussée
// `self.__next_s` que le runtime Next injecte côté client) — `document.currentScript` est donc nul
// ET le tag injecté est `async`, les deux conditions sur lesquelles l'auto-validation d'App Bridge
// lève « must be included as the first <script> tag ». Ni `async`, ni `defer`, ni `type` ici.
//
// `nonce` est indispensable, pas cosmétique : le régime CSP « embedded » est nonce +
// 'strict-dynamic' (lib/security/csp.ts), qui fait ignorer `https:` aux navigateurs récents — sans
// nonce, le CDN Shopify est bloqué en production. Contrat mesuré sur le HTML réellement servi dans
// tests/e2e/shopify-koba-multi-app.spec.ts.
export function EmbeddedAppShell({
  app,
  host,
  embedded,
  supportEmail,
  appLabel,
  nonce,
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
      <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" nonce={nonce ?? undefined} />
      <EmbeddedShopifySurface
        clientId={app?.clientId ?? null}
        host={host ?? null}
        supportEmail={supportEmail}
        appLabel={appLabel}
      />
    </>
  );
}
