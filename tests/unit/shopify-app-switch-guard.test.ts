import { decideShopAppSwitch } from '@/lib/shopify/app-switch-guard';
import { describe, expect, it } from 'vitest';

describe('garde de bascule d’app (rattachement embarqué)', () => {
  it('autorise quand aucune boutique n’existe pour ce domaine', () => {
    expect(decideShopAppSwitch(null, 'public_client')).toEqual({ kind: 'ok' });
  });

  it('autorise quand la boutique existante n’a jamais eu d’app assignée (shopify_client_id NULL)', () => {
    expect(decideShopAppSwitch({ shopify_client_id: null }, 'public_client')).toEqual({
      kind: 'ok',
    });
  });

  it('autorise une reconnexion par la même app', () => {
    expect(decideShopAppSwitch({ shopify_client_id: 'public_client' }, 'public_client')).toEqual({
      kind: 'ok',
    });
  });

  it('refuse quand la boutique appartient déjà à une autre app, même tenant potentiellement identique', () => {
    expect(decideShopAppSwitch({ shopify_client_id: 'koba_client' }, 'public_client')).toEqual({
      kind: 'refuse',
    });
  });
});
