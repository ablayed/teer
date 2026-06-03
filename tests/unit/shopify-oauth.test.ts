import { createHmac } from 'node:crypto';
import { buildAuthorizeUrl, validateShopDomain, verifyOAuthHmac } from '@/lib/shopify/oauth';
import { describe, expect, it } from 'vitest';

function signParams(searchParams: URLSearchParams, secret: string): string {
  const message = Array.from(searchParams.entries())
    .filter(([key]) => key !== 'hmac' && key !== 'signature')
    .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  return createHmac('sha256', secret).update(message).digest('hex');
}

describe('validateShopDomain', () => {
  it('accepts a valid myshopify domain', () => {
    expect(validateShopDomain('teer-test.myshopify.com')).toBe(true);
  });

  it('rejects an unrelated domain', () => {
    expect(validateShopDomain('evil.com')).toBe(false);
  });

  it('rejects a suffix attack domain', () => {
    expect(validateShopDomain('teer-test.myshopify.com.evil.com')).toBe(false);
  });

  it('rejects a URL with a protocol', () => {
    expect(validateShopDomain('http://x.myshopify.com')).toBe(false);
  });

  it('rejects an empty value', () => {
    expect(validateShopDomain('')).toBe(false);
  });
});

describe('buildAuthorizeUrl', () => {
  it('builds an offline managed-install OAuth URL with required Shopify scopes', () => {
    const authorizeUrl = buildAuthorizeUrl({
      shop: 'teer-test.myshopify.com',
      clientId: 'client_123',
      redirectUri: 'http://localhost:3000/api/shopify/callback',
      state: 'nonce_123',
    });
    const url = new URL(authorizeUrl);

    expect(url.origin).toBe('https://teer-test.myshopify.com');
    expect(url.pathname).toBe('/admin/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('client_123');
    expect(authorizeUrl).toContain(
      'redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fapi%2Fshopify%2Fcallback',
    );
    expect(url.searchParams.get('state')).toBe('nonce_123');
    expect(url.searchParams.get('scope')).toBe('read_orders,read_customers,read_products');
    expect(authorizeUrl).not.toContain('grant_options');
  });
});

describe('verifyOAuthHmac', () => {
  it('accepts a valid OAuth callback HMAC', () => {
    const secret = 'shpss_test_secret';
    const params = new URLSearchParams({
      code: 'code_123',
      shop: 'teer-test.myshopify.com',
      state: 'nonce_123',
      timestamp: '1780000000',
    });
    params.set('hmac', signParams(params, secret));

    expect(verifyOAuthHmac(params, secret)).toBe(true);
  });

  it('rejects an altered HMAC', () => {
    const secret = 'shpss_test_secret';
    const params = new URLSearchParams({
      code: 'code_123',
      shop: 'teer-test.myshopify.com',
      state: 'nonce_123',
      timestamp: '1780000000',
      hmac: '00',
    });

    expect(verifyOAuthHmac(params, secret)).toBe(false);
  });

  it('rejects a missing HMAC', () => {
    const params = new URLSearchParams({
      code: 'code_123',
      shop: 'teer-test.myshopify.com',
      state: 'nonce_123',
      timestamp: '1780000000',
    });

    expect(verifyOAuthHmac(params, 'shpss_test_secret')).toBe(false);
  });
});
