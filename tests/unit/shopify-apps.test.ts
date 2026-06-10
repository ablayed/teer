import { createShopifyAppRegistry } from '@/lib/shopify/app-registry';
import { describe, expect, it } from 'vitest';

const TEER_DEV = { label: 'teer-dev' as const, clientId: 'dev_client', clientSecret: 'dev_secret' };
const TEER_PILOTE = {
  label: 'teer-pilote' as const,
  clientId: '4a2cd2a0befe5d828e67b436edad7d5d',
  clientSecret: 'pilote_secret',
};

describe('createShopifyAppRegistry', () => {
  it('routes a client_id to the matching app config (Dev vs Pilote)', () => {
    const registry = createShopifyAppRegistry([TEER_DEV, TEER_PILOTE]);

    const dev = registry.getByClientId('dev_client');
    const pilote = registry.getByClientId('4a2cd2a0befe5d828e67b436edad7d5d');

    expect(dev?.label).toBe('teer-dev');
    expect(dev?.clientSecret).toBe('dev_secret');
    expect(pilote?.label).toBe('teer-pilote');
    expect(pilote?.clientSecret).toBe('pilote_secret');
    // Le secret de Pilote ne fuit pas vers Dev, et inversement.
    expect(dev?.clientSecret).not.toBe(pilote?.clientSecret);
  });

  it('rejects an unknown client_id', () => {
    const registry = createShopifyAppRegistry([TEER_DEV, TEER_PILOTE]);

    expect(registry.getByClientId('inconnu')).toBeNull();
    expect(registry.getByClientId(null)).toBeNull();
    expect(registry.getByClientId(undefined)).toBeNull();
    expect(registry.getByClientId('')).toBeNull();
  });

  it('exposes the common scopes on each app', () => {
    const registry = createShopifyAppRegistry([TEER_DEV, TEER_PILOTE]);

    expect(registry.getByClientId('dev_client')?.scopes).toBe(
      'read_orders,read_customers,read_products',
    );
  });

  it('uses Teer Dev as the default app (rétrocompat)', () => {
    // Même si Pilote est listée en premier, le défaut reste Teer Dev.
    const registry = createShopifyAppRegistry([TEER_PILOTE, TEER_DEV]);

    expect(registry.getDefault()?.label).toBe('teer-dev');
  });

  it('falls back to the first registered app when Teer Dev is absent', () => {
    const registry = createShopifyAppRegistry([TEER_PILOTE]);

    expect(registry.getDefault()?.label).toBe('teer-pilote');
    expect(registry.all()).toHaveLength(1);
  });

  it('skips an app whose credentials are incomplete or missing', () => {
    const registry = createShopifyAppRegistry([
      TEER_DEV,
      { label: 'teer-pilote', clientId: 'pilote_only_id', clientSecret: undefined },
    ]);

    expect(registry.getByClientId('pilote_only_id')).toBeNull();
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
