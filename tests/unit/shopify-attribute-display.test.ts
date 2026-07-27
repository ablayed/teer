import {
  filterShopifyAttributesForDisplay,
  isShopifyAttributeDisplayable,
} from '@/lib/orders/shopify-attribute-display';
import { describe, expect, it } from 'vitest';

describe('isShopifyAttributeDisplayable', () => {
  it.each([
    'utm_source',
    'UTM_MEDIUM',
    'utm_campaign',
    'shopify-cart-token',
    'checkout_url',
    'full_URL',
    'IP Address',
    'ip_address',
    '_',
  ])('masque le champ bruité %s', (key) => {
    expect(isShopifyAttributeDisplayable({ key })).toBe(false);
  });

  it.each(['Nom', 'Téléphone', 'Disponibilité', 'Étage'])(
    'laisse afficher le champ utile %s',
    (key) => {
      expect(isShopifyAttributeDisplayable({ key })).toBe(true);
    },
  );
});

describe('filterShopifyAttributesForDisplay', () => {
  it('conserve les attributs inconnus sans interpréter leurs valeurs', () => {
    const attributes = [
      { key: 'Nom', value: 'Awa Diop' },
      { key: 'utm_source', value: 'facebook' },
      { key: 'Étage', value: '3e' },
    ];

    expect(filterShopifyAttributesForDisplay(attributes)).toEqual([
      { key: 'Nom', value: 'Awa Diop' },
      { key: 'Étage', value: '3e' },
    ]);
  });
});
