// APP-03 / Lot 2 — l'entrée embarquée sans segment de label reste un alias EXPLICITE et nommé
// vers Teer Dev, jamais un repli implicite sur "l'app par défaut du registre" (dont l'ordre
// pourrait un jour changer sans intention de routage).
import { describe, expect, it, vi } from 'vitest';

const DEV_APP = { label: 'teer-dev' as const, clientId: 'dev_client', clientSecret: 'dev_secret' };
const PUBLIC_APP = {
  label: 'teer-public' as const,
  clientId: 'public_client',
  clientSecret: 'public_secret',
};

const getShopifyAppByLabel = vi.fn((label: string) => {
  if (label === 'teer-dev') return DEV_APP;
  if (label === 'teer-public') return PUBLIC_APP;
  return null;
});

vi.mock('@/lib/shopify/apps', () => ({
  getShopifyAppByLabel: (label: string) => getShopifyAppByLabel(label),
}));

describe('résolution de l’app embarquée', () => {
  it('résout Teer Dev par label explicite quand aucun segment n’est fourni, sans passer par un "défaut" générique', async () => {
    const { getShopifyAppOrNullForEmbedded } = await import('@/lib/shopify/embedded');

    const result = getShopifyAppOrNullForEmbedded();

    expect(result).toEqual(DEV_APP);
    expect(getShopifyAppByLabel).toHaveBeenCalledWith('teer-dev');
  });

  it('résout l’app par son label explicite quand un segment est fourni', async () => {
    const { getShopifyAppOrNullForEmbedded } = await import('@/lib/shopify/embedded');

    const result = getShopifyAppOrNullForEmbedded('teer-public');

    expect(result).toEqual(PUBLIC_APP);
    expect(getShopifyAppByLabel).toHaveBeenCalledWith('teer-public');
  });

  it('refuse un label inconnu sans jamais retomber sur Teer Dev', async () => {
    const { getShopifyAppOrNullForEmbedded } = await import('@/lib/shopify/embedded');

    const result = getShopifyAppOrNullForEmbedded('teer-unknown');

    expect(result).toBeNull();
    expect(getShopifyAppByLabel).toHaveBeenCalledWith('teer-unknown');
  });
});
