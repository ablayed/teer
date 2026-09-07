import type { ShopifyAppConfig } from '@/lib/shopify/app-registry';
import { selectEmbeddedInstallApp } from '@/lib/shopify/embedded-install-selection';
import { describe, expect, it } from 'vitest';

const dev: ShopifyAppConfig = {
  label: 'teer-dev',
  clientId: 'dev_client_sentinel',
  clientSecret: 'dev_secret_sentinel',
  scopes: 'read_orders,read_customers,read_products',
};
const publicApp: ShopifyAppConfig = {
  label: 'teer-public',
  clientId: 'public_client_sentinel',
  clientSecret: 'public_secret_sentinel',
  scopes: 'read_orders,read_customers,read_products',
};

function lookup(publicConfigured = true) {
  return {
    getDefault: () => dev,
    getByLabel: (label: string) => (label === 'teer-public' && publicConfigured ? publicApp : null),
    hasLabel: (label: string) => label === 'teer-public' || label === 'teer-dev',
  };
}

describe('sélection du parcours embedded Shopify', () => {
  it('sélectionne Teer Public explicitement par son label', () => {
    expect(selectEmbeddedInstallApp('teer-public', lookup()).app?.label).toBe('teer-public');
  });

  it('refuse un label inconnu sans repli vers Teer Dev', () => {
    const result = selectEmbeddedInstallApp('teer-unknown', lookup());

    expect(result.kind).toBe('unknown_label');
    expect(result.app).toBeNull();
  });

  it('refuse une app connue dont les credentials manquent sans repli', () => {
    const result = selectEmbeddedInstallApp('teer-public', lookup(false));

    expect(result.kind).toBe('missing_credentials');
    expect(result.app).toBeNull();
  });

  it('conserve Teer Dev pour le chemin sans label', () => {
    expect(selectEmbeddedInstallApp(null, lookup()).app?.label).toBe('teer-dev');
  });
});
