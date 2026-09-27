import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const apps = {
    'teer-public': {
      label: 'teer-public',
      clientId: 'public-client',
      clientSecret: 'public-secret',
      distribution: 'public',
      scopes: 'read_orders',
    },
    'teer-koba': {
      label: 'teer-koba',
      clientId: 'koba-client',
      clientSecret: 'koba-secret',
      distribution: 'custom',
      scopes: 'read_orders',
    },
  };
  const redirect = vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  });
  const shell = vi.fn(
    ({
      app,
      host,
      embedded,
    }: { app: { clientId: string } | null; host?: string; embedded?: string }) => {
      if (embedded !== '1' && host && app)
        redirect(`https://admin.shopify.com/store/store/apps/${app.clientId}`);
      return null;
    },
  );
  const cookieSet = vi.fn();
  const cookieDelete = vi.fn();
  return { apps, cookieSet, cookieDelete, redirect, shell };
});

vi.mock('next/navigation', () => ({ redirect: harness.redirect }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-nonce': 'nonce-test' }),
  cookies: async () => ({
    set: harness.cookieSet,
    delete: harness.cookieDelete,
  }),
}));
vi.mock('@/lib/env', () => ({ publicEnv: { NEXT_PUBLIC_SUPPORT_EMAIL: null } }));
vi.mock('@/lib/shopify/apps', () => ({
  getShopifyAppByLabel: (label: string) => harness.apps[label as keyof typeof harness.apps] ?? null,
}));
vi.mock('@/app/shopify/embedded/embedded-app-shell', () => ({ EmbeddedAppShell: harness.shell }));

const SHOP = 'test-shop.myshopify.com';

function buildQuery(shop: string, secret: string, overrides: Record<string, string> = {}) {
  const values = new URLSearchParams({
    shop,
    timestamp: String(Math.floor(Date.now() / 1000)),
    host: Buffer.from('admin.shopify.com/store/test-shop').toString('base64url'),
    ...overrides,
  });
  const message = Array.from(values.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  values.set('hmac', createHmac('sha256', secret).update(message).digest('hex'));
  return Object.fromEntries(values.entries());
}

async function renderEntry(
  appLabel: string,
  searchParams: Record<string, string | string[] | undefined>,
) {
  const { default: Page } = await import('@/app/shopify/embedded/[appLabel]/page');
  return Page({
    params: Promise.resolve({ appLabel }),
    searchParams: Promise.resolve(searchParams),
  });
}

describe('entrÃ©e Shopify non embarquÃ©e', () => {
  beforeEach(() => {
    harness.redirect.mockClear();
    harness.shell.mockClear();
    harness.cookieSet.mockClear();
    harness.cookieDelete.mockClear();
  });

  it('accepte le HMAC de application_url et garde seulement une intention signÃ©e app/shop', async () => {
    await expect(renderEntry('teer-public', buildQuery(SHOP, 'public-secret'))).rejects.toThrow(
      /^REDIRECT:\/api\/shopify\/non-embedded-intent\?intent=/,
    );
    expect(harness.shell).not.toHaveBeenCalled();
    const redirectCall = harness.redirect.mock.calls[0]?.[0] ?? '';
    expect(redirectCall).not.toContain('hmac=');
    expect(redirectCall).toMatch(/^\/api\/shopify\/non-embedded-intent\?intent=/);
    const token = new URL(`http://localhost${redirectCall}`).searchParams.get('intent') ?? '';
    const payload = JSON.parse(
      Buffer.from(String(token).split('.')[0] ?? '', 'base64url').toString(),
    );
    expect(payload).toMatchObject({ appLabel: 'teer-public', shop: SHOP });
    expect(payload).not.toHaveProperty('host');
    expect(payload).not.toHaveProperty('hmac');
  });

  it('refuse un HMAC invalide et ne pose aucune intention', async () => {
    const query = buildQuery(SHOP, 'public-secret');
    query.hmac = '0'.repeat(64);
    const result = await renderEntry('teer-public', query);
    expect(result.props['data-error']).toBe('invalid_hmac');
    expect(harness.redirect).not.toHaveBeenCalled();
  });

  it('nomme le refus d’un appLabel inconnu', async () => {
    const result = await renderEntry('unknown-app', buildQuery(SHOP, 'public-secret'));
    expect(result.props['data-error']).toBe('unknown_app_label');
    expect(harness.redirect).not.toHaveBeenCalled();
  });

  it('refuse dans les deux sens une signature prÃ©sentÃ©e sur le chemin de la mauvaise app', async () => {
    const signedByPublic = await renderEntry(
      'teer-koba',
      buildQuery(SHOP, harness.apps['teer-public'].clientSecret),
    );
    const signedByKoba = await renderEntry(
      'teer-public',
      buildQuery(SHOP, harness.apps['teer-koba'].clientSecret),
    );
    expect(signedByPublic.props['data-error']).toBe('invalid_hmac');
    expect(signedByKoba.props['data-error']).toBe('invalid_hmac');
    expect(harness.redirect).not.toHaveBeenCalled();
  });

  it('conserve le parcours embarquÃ© uniquement pour embedded=1', async () => {
    const result = await renderEntry('teer-public', { embedded: '1', host: 'test-host' });
    expect(result.type).toBe(harness.shell);
    expect(result.props).toMatchObject({ embedded: '1', host: 'test-host' });
  });
});
