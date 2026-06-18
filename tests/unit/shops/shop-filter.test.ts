import { type ShopFilterOption, normalizeShopParam } from '@/lib/shops/shop-filter';
import { describe, expect, it } from 'vitest';

const shops: ShopFilterOption[] = [
  { id: '11111111-1111-1111-1111-111111111111', label: 'a.myshopify.com' },
  { id: '22222222-2222-2222-2222-222222222222', label: 'b.myshopify.com' },
];

describe('normalizeShopParam', () => {
  it('retourne null pour absence de valeur (= toutes les boutiques)', () => {
    expect(normalizeShopParam(undefined, shops)).toBeNull();
    expect(normalizeShopParam(null, shops)).toBeNull();
    expect(normalizeShopParam('', shops)).toBeNull();
  });

  it('retourne null pour le sentinel « all »', () => {
    expect(normalizeShopParam('all', shops)).toBeNull();
  });

  it('retourne l’id quand il appartient au tenant', () => {
    expect(normalizeShopParam(shops[0].id, shops)).toBe(shops[0].id);
  });

  it('retourne null pour un id inconnu (boutique d’un autre tenant)', () => {
    expect(normalizeShopParam('99999999-9999-9999-9999-999999999999', shops)).toBeNull();
  });

  it('retourne null quand le tenant n’a aucune boutique', () => {
    expect(normalizeShopParam(shops[0].id, [])).toBeNull();
  });
});
