import { createShopifyAppRegistry } from '@/lib/shopify/app-registry';
import { describe, expect, it } from 'vitest';

const TEER_DEV = { label: 'teer-dev' as const, clientId: 'dev_client', clientSecret: 'dev_secret' };
const TEER_PILOTE = {
  label: 'teer-pilote' as const,
  clientId: '4a2cd2a0befe5d828e67b436edad7d5d',
  clientSecret: 'pilote_secret',
};
const TEER_MARCHAND = {
  label: 'teer-marchand' as const,
  clientId: 'marchand_client',
  clientSecret: 'marchand_secret',
};
const TEER_KOBA = {
  label: 'teer-koba' as const,
  clientId: 'koba_client',
  clientSecret: 'koba_secret',
};

describe('createShopifyAppRegistry', () => {
  it('routes each client_id to the matching app config (Dev, Pilote, Marchand, Koba)', () => {
    const registry = createShopifyAppRegistry([TEER_DEV, TEER_PILOTE, TEER_MARCHAND, TEER_KOBA]);

    const dev = registry.getByClientId('dev_client');
    const pilote = registry.getByClientId('4a2cd2a0befe5d828e67b436edad7d5d');
    const marchand = registry.getByClientId('marchand_client');
    const koba = registry.getByClientId('koba_client');

    expect(dev?.label).toBe('teer-dev');
    expect(dev?.clientSecret).toBe('dev_secret');
    expect(pilote?.label).toBe('teer-pilote');
    expect(pilote?.clientSecret).toBe('pilote_secret');
    expect(marchand?.label).toBe('teer-marchand');
    expect(marchand?.clientSecret).toBe('marchand_secret');
    expect(koba?.label).toBe('teer-koba');
    expect(koba?.clientSecret).toBe('koba_secret');
    expect(dev?.clientSecret).not.toBe(pilote?.clientSecret);
    expect(dev?.clientSecret).not.toBe(marchand?.clientSecret);
    expect(dev?.clientSecret).not.toBe(koba?.clientSecret);
    expect(pilote?.clientSecret).not.toBe(marchand?.clientSecret);
    expect(pilote?.clientSecret).not.toBe(koba?.clientSecret);
    expect(marchand?.clientSecret).not.toBe(koba?.clientSecret);
    expect(registry.all()).toHaveLength(4);
  });

  it('rejects an unknown client_id', () => {
    const registry = createShopifyAppRegistry([TEER_DEV, TEER_PILOTE, TEER_MARCHAND, TEER_KOBA]);

    expect(registry.getByClientId('inconnu')).toBeNull();
    expect(registry.getByClientId(null)).toBeNull();
    expect(registry.getByClientId(undefined)).toBeNull();
    expect(registry.getByClientId('')).toBeNull();
  });

  it('exposes the common scopes on each app', () => {
    const registry = createShopifyAppRegistry([TEER_DEV, TEER_PILOTE, TEER_MARCHAND, TEER_KOBA]);

    expect(registry.getByClientId('dev_client')?.scopes).toBe(
      'read_orders,read_customers,read_products',
    );
  });

  it('uses Teer Dev as the default app (retrocompat)', () => {
    // Meme si Pilote, Marchand et Koba sont listes avant, le defaut reste Teer Dev.
    const registry = createShopifyAppRegistry([TEER_PILOTE, TEER_MARCHAND, TEER_KOBA, TEER_DEV]);

    expect(registry.getDefault()?.label).toBe('teer-dev');
  });

  it('falls back to the first registered app when Teer Dev is absent', () => {
    const registry = createShopifyAppRegistry([TEER_PILOTE, TEER_MARCHAND, TEER_KOBA]);

    expect(registry.getDefault()?.label).toBe('teer-pilote');
    expect(registry.all()).toHaveLength(3);
  });

  it('skips an app whose credentials are incomplete or missing', () => {
    const registry = createShopifyAppRegistry([
      TEER_DEV,
      { label: 'teer-pilote', clientId: 'pilote_only_id', clientSecret: undefined },
      { label: 'teer-marchand', clientId: undefined, clientSecret: 'marchand_only_secret' },
      { label: 'teer-koba', clientId: 'koba_only_id', clientSecret: undefined },
    ]);

    expect(registry.getByClientId('pilote_only_id')).toBeNull();
    expect(registry.getByClientId('marchand_only_secret')).toBeNull();
    expect(registry.getByClientId('koba_only_id')).toBeNull();
    expect(registry.all()).toHaveLength(1);
    expect(registry.all()[0]?.label).toBe('teer-dev');
  });

  it('returns no default when no app is configured', () => {
    const registry = createShopifyAppRegistry([
      { label: 'teer-dev', clientId: undefined, clientSecret: undefined },
    ]);

    expect(registry.getDefault()).toBeNull();
    expect(registry.all()).toHaveLength(0);
  });
});

// Reproduit la resolution par boutique (getShopifyAppForShop) : son comportement = on prend l'app
// du client_id stocke, sinon on retombe sur l'app par defaut (Teer Dev). Garantit la NON-REGRESSION
// des boutiques existantes (shopify_client_id = Teer Dev apres backfill, ou null pour un legacy).
describe('resolution par boutique (non-regression Teer Dev)', () => {
  const registry = createShopifyAppRegistry([TEER_DEV, TEER_PILOTE, TEER_MARCHAND, TEER_KOBA]);
  const resolveForShop = (clientId: string | null | undefined) =>
    registry.getByClientId(clientId) ?? registry.getDefault();

  it('resout une boutique Teer Pilote vers les credentials Pilote', () => {
    expect(resolveForShop(TEER_PILOTE.clientId)?.label).toBe('teer-pilote');
  });

  it('resout une boutique Teer Marchand vers les credentials Marchand', () => {
    expect(resolveForShop(TEER_MARCHAND.clientId)?.label).toBe('teer-marchand');
  });

  it('resout une boutique Teer Koba vers les credentials Koba', () => {
    expect(resolveForShop(TEER_KOBA.clientId)?.label).toBe('teer-koba');
  });

  it('resout une boutique Teer Dev vers les credentials Dev', () => {
    expect(resolveForShop(TEER_DEV.clientId)?.label).toBe('teer-dev');
  });

  it('retombe sur Teer Dev pour un client_id null/inconnu (boutique legacy)', () => {
    expect(resolveForShop(null)?.label).toBe('teer-dev');
    expect(resolveForShop(undefined)?.label).toBe('teer-dev');
    expect(resolveForShop('boutique_sans_app_connue')?.label).toBe('teer-dev');
  });
});
