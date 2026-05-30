import { generateNonce, signState, verifyState } from '@/lib/shopify/state';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const originalSecret = process.env.SHOPIFY_API_SECRET;

beforeEach(() => {
  process.env.SHOPIFY_API_SECRET = 'shpss_test_secret';
});

afterEach(() => {
  if (originalSecret === undefined) {
    Reflect.deleteProperty(process.env, 'SHOPIFY_API_SECRET');
    return;
  }

  process.env.SHOPIFY_API_SECRET = originalSecret;
});

describe('Shopify OAuth state', () => {
  it('round-trips a signed state payload', () => {
    const payload = {
      nonce: 'nonce_123',
      merchantAccountId: 'merchant_123',
      shopDomain: 'teer-test.myshopify.com',
      exp: Date.now() + 60_000,
    };

    expect(verifyState(signState(payload))).toEqual(payload);
  });

  it('returns null when the signature is altered', () => {
    const token = signState({
      nonce: 'nonce_123',
      merchantAccountId: 'merchant_123',
      shopDomain: 'teer-test.myshopify.com',
      exp: Date.now() + 60_000,
    });

    const alteredLastCharacter = token.endsWith('0') ? '1' : '0';

    expect(verifyState(`${token.slice(0, -1)}${alteredLastCharacter}`)).toBeNull();
  });

  it('returns null when the payload is expired', () => {
    const token = signState({
      nonce: 'nonce_123',
      merchantAccountId: 'merchant_123',
      shopDomain: 'teer-test.myshopify.com',
      exp: Date.now() - 1,
    });

    expect(verifyState(token)).toBeNull();
  });

  it('returns null when the token is malformed', () => {
    expect(verifyState('not-a-valid-state-token')).toBeNull();
  });

  it('generates a 16-byte nonce encoded as hex', () => {
    expect(generateNonce()).toMatch(/^[0-9a-f]{32}$/);
  });
});
