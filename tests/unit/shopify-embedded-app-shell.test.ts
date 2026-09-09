// APP-03 / Lot 3 — porte embarquée : embedded absent/0 redirige 3xx vers la destination
// canonique Shopify Admin ; embedded=1 rend la surface normalement, jamais de destination devinée.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
vi.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));
vi.mock('@/app/shopify/embedded/embedded-shopify-surface', () => ({
  EmbeddedShopifySurface: () => null,
}));

const APP = {
  label: 'teer-public' as const,
  clientId: 'public-client-sentinel',
  clientSecret: 's',
  scopes: 'read_customers,read_orders,read_products',
};
const MODERN_HOST = Buffer.from('admin.shopify.com/store/acme-shop', 'utf8').toString('base64url');

describe('EmbeddedAppShell', () => {
  beforeEach(() => {
    redirect.mockClear();
  });

  it('redirige vers la destination canonique quand embedded est absent, avec host+app valides', async () => {
    const { EmbeddedAppShell } = await import('@/app/shopify/embedded/embedded-app-shell');

    expect(() =>
      EmbeddedAppShell({
        app: APP,
        host: MODERN_HOST,
        embedded: undefined,
        supportEmail: null,
      }),
    ).toThrow(`REDIRECT:https://admin.shopify.com/store/acme-shop/apps/${APP.clientId}`);
  });

  it('redirige aussi quand embedded=0', async () => {
    const { EmbeddedAppShell } = await import('@/app/shopify/embedded/embedded-app-shell');

    expect(() =>
      EmbeddedAppShell({ app: APP, host: MODERN_HOST, embedded: '0', supportEmail: null }),
    ).toThrow(`REDIRECT:https://admin.shopify.com/store/acme-shop/apps/${APP.clientId}`);
  });

  it("ne redirige jamais quand embedded='1', même avec host valide", async () => {
    const { EmbeddedAppShell } = await import('@/app/shopify/embedded/embedded-app-shell');

    expect(() =>
      EmbeddedAppShell({ app: APP, host: MODERN_HOST, embedded: '1', supportEmail: null }),
    ).not.toThrow();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('ne redirige jamais, ne devine aucune destination, quand host est absent', async () => {
    const { EmbeddedAppShell } = await import('@/app/shopify/embedded/embedded-app-shell');

    expect(() =>
      EmbeddedAppShell({ app: APP, host: undefined, embedded: undefined, supportEmail: null }),
    ).not.toThrow();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('ne redirige jamais quand host est invalide (fermé, pas de destination devinée depuis un sous-domaine)', async () => {
    const { EmbeddedAppShell } = await import('@/app/shopify/embedded/embedded-app-shell');

    expect(() =>
      EmbeddedAppShell({
        app: APP,
        host: 'not-a-valid-host',
        embedded: undefined,
        supportEmail: null,
      }),
    ).not.toThrow();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("ne redirige jamais quand l'app n'est pas résolue (pas de client_id pour construire la destination)", async () => {
    const { EmbeddedAppShell } = await import('@/app/shopify/embedded/embedded-app-shell');

    expect(() =>
      EmbeddedAppShell({ app: null, host: MODERN_HOST, embedded: undefined, supportEmail: null }),
    ).not.toThrow();
    expect(redirect).not.toHaveBeenCalled();
  });
});
