import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildCspHeader, cspRegimeForPath } from '@/lib/security/csp';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(resolve(file), 'utf8');

describe('Shopify embedded review surface', () => {
  it('is configured as embedded and loads App Bridge before the surface, meta key before the script', () => {
    const config = read('shopify.app.toml');
    const shell = read('app/shopify/embedded/embedded-app-shell.tsx');
    const surface = read('app/shopify/embedded/embedded-shopify-surface.tsx');

    expect(config).toContain('embedded = true');
    expect(config).toContain('application_url = "https://teer-dev.vercel.app/shopify/embedded"');
    expect(shell.indexOf('shopify-api-key')).toBeLessThan(shell.indexOf('app-bridge.js'));
    expect(shell.indexOf('app-bridge.js')).toBeLessThan(shell.indexOf('<EmbeddedShopifySurface'));
    expect(shell).toContain('strategy="beforeInteractive"');
    expect(surface).not.toContain('SHOPIFY_API_SECRET');
    expect(surface).not.toContain('access_token');
    expect(surface).not.toContain('bridge.config');
  });

  it('exposes a generic labelled entry without changing the default entry', () => {
    const labelledPage = read('app/shopify/embedded/[appLabel]/page.tsx');
    const installRoute = read('app/api/shopify/embedded/install/route.ts');
    const publicConfig = read('shopify.app.teer-public.toml');

    expect(labelledPage).toContain('getShopifyAppOrNullForEmbedded(appLabel)');
    expect(installRoute).toContain("searchParams.get('app_label')");
    expect(installRoute).toContain("searchParams.set('client_id', selectedApp.clientId)");
    expect(read('app/shopify/embedded/page.tsx')).toContain('getShopifyAppOrNullForEmbedded()');
    expect(publicConfig).toContain('client_id = "__A_RENSEIGNER__"');
    expect(publicConfig).toContain(
      'application_url = "https://teer-dev.vercel.app/shopify/embedded/teer-public"',
    );
    expect(publicConfig).not.toContain('[[webhooks.subscriptions]]');
  });

  it('uses a dedicated Shopify frame policy and keeps the rest of the app unembeddable', () => {
    expect(cspRegimeForPath('/shopify/embedded')).toBe('embedded');
    expect(cspRegimeForPath('/shopify/embedded/teer-public')).toBe('embedded');
    expect(cspRegimeForPath('/tableau')).toBe('app');
    // L'écran de confirmation de rattachement est délibérément TOP-LEVEL uniquement (retour
    // depuis /connexion après sortie de l'iframe) — jamais embarquable, même si son chemin
    // commence par "/shopify/embedded" en préfixe textuel.
    expect(cspRegimeForPath('/shopify/embedded-link')).toBe('app');

    const embeddedCsp = buildCspHeader({ regime: 'embedded', isDev: false, nonce: 'synthetic' });
    const appCsp = buildCspHeader({ regime: 'app', isDev: false, nonce: 'synthetic' });
    expect(embeddedCsp).toContain(
      'frame-ancestors https://admin.shopify.com https://*.myshopify.com',
    );
    expect(appCsp).toContain("frame-ancestors 'none'");
  });

  it('does not expose a domain input or a public installation link in the cockpit', () => {
    const page = read('app/(app)/boutiques/page.tsx');

    expect(page).not.toContain('ConnectShopForm');
    expect(page).not.toContain('/api/shopify/install?shop=');
  });
});
