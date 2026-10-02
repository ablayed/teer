// SHOPIFY-OAUTH-FIRST-01 / B1 — la branche non embarquée de la page d'app ne décide plus rien :
// elle transmet la requête signée par Shopify au route handler d'entrée, sans rendu. Les gardes
// (HMAC, fenêtre, domaine, classification) sont prouvées sur le route handler lui-même
// (tests/unit/shopify-oauth-first-entry.test.ts).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const redirect = vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  });
  const shell = vi.fn(() => null);
  return { redirect, shell };
});

vi.mock('next/navigation', () => ({ redirect: harness.redirect }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-nonce': 'nonce-test' }),
}));
vi.mock('@/lib/env', () => ({ publicEnv: { NEXT_PUBLIC_SUPPORT_EMAIL: null } }));
vi.mock('@/lib/shopify/embedded', () => ({
  getShopifyAppOrNullForEmbedded: () => ({ clientId: 'public-client-id' }),
}));
vi.mock('@/app/shopify/embedded/embedded-app-shell', () => ({ EmbeddedAppShell: harness.shell }));

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

describe('entrée Shopify non embarquée — trampoline vers le route handler', () => {
  beforeEach(() => {
    harness.redirect.mockClear();
    harness.shell.mockClear();
  });

  it('transmet la requête signée telle quelle, sans rien rendre', async () => {
    const query = {
      shop: 'test-shop.myshopify.com',
      timestamp: '1790000000',
      host: 'aG9zdA',
      hmac: 'a'.repeat(64),
    };
    await expect(renderEntry('teer-public', query)).rejects.toThrow(/^REDIRECT:/);
    expect(harness.shell).not.toHaveBeenCalled();

    const target = new URL(`http://localhost${harness.redirect.mock.calls[0]?.[0] ?? ''}`);
    expect(target.pathname).toBe('/api/shopify/entry/teer-public');
    expect(Object.fromEntries(target.searchParams.entries())).toEqual(query);
  });

  it('conserve les paramètres dupliqués, pour que le refus reste celui de la vérification', async () => {
    await expect(
      renderEntry('teer-public', {
        shop: ['a.myshopify.com', 'b.myshopify.com'],
        hmac: 'a'.repeat(64),
        timestamp: '1790000000',
      }),
    ).rejects.toThrow(/^REDIRECT:/);
    const target = new URL(`http://localhost${harness.redirect.mock.calls[0]?.[0] ?? ''}`);
    expect(target.searchParams.getAll('shop')).toEqual(['a.myshopify.com', 'b.myshopify.com']);
  });

  it('conserve le parcours embarqué uniquement pour embedded=1', async () => {
    const result = await renderEntry('teer-public', { embedded: '1', host: 'test-host' });
    expect(harness.redirect).not.toHaveBeenCalled();
    expect(result.type).toBe(harness.shell);
    expect(result.props).toMatchObject({ embedded: '1', host: 'test-host' });
  });
});
