import { shopStatus } from '@/lib/shopify/shop-status';
import { describe, expect, it } from 'vitest';

describe('shopStatus', () => {
  it('renvoie uninstalled quand la boutique est déconnectée, quel que soit le token', () => {
    expect(
      shopStatus({
        status: 'uninstalled',
        storeKind: 'shopify',
        accessTokenEncrypted: 'encrypted',
        accessTokenExpiresAt: null,
      }),
    ).toEqual({ status: 'uninstalled', reason: null });
  });

  it('renvoie incomplete pour une boutique shopify active sans access_token_encrypted', () => {
    expect(
      shopStatus({
        status: 'active',
        storeKind: 'shopify',
        accessTokenEncrypted: null,
        accessTokenExpiresAt: null,
      }),
    ).toEqual({ status: 'incomplete', reason: null });
  });

  it('ne confond jamais une boutique manuelle (sans token par conception) avec incomplete', () => {
    expect(
      shopStatus({
        status: 'active',
        storeKind: 'manual',
        accessTokenEncrypted: null,
        accessTokenExpiresAt: null,
      }),
    ).toEqual({ status: 'connected', reason: null });
  });

  it('renvoie error/token_expired pour un jeton shopify expiré', () => {
    expect(
      shopStatus({
        status: 'active',
        storeKind: 'shopify',
        accessTokenEncrypted: 'encrypted',
        accessTokenExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    ).toEqual({ status: 'error', reason: 'token_expired' });
  });

  it('renvoie connected pour une boutique shopify active avec un token valide', () => {
    expect(
      shopStatus({
        status: 'active',
        storeKind: 'shopify',
        accessTokenEncrypted: 'encrypted',
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    ).toEqual({ status: 'connected', reason: null });
  });

  it('renvoie connected pour une boutique shopify active sans expiration connue (token non expirant)', () => {
    expect(
      shopStatus({
        status: 'active',
        storeKind: 'shopify',
        accessTokenEncrypted: 'encrypted',
        accessTokenExpiresAt: null,
      }),
    ).toEqual({ status: 'connected', reason: null });
  });
});
