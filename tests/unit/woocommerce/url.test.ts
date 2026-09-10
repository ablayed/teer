import { normalizeWooCommerceIdentity, parseWooCommerceRequestUrl } from '@/lib/woocommerce/url';
import { describe, expect, it } from 'vitest';

describe('WooCommerce URL canonicalisation', () => {
  it('normalise HTTPS, host casing, default port and trailing path slash', () => {
    expect(normalizeWooCommerceIdentity('HTTPS://Shop.Example.test:443/WordPress/')).toBe(
      'https://shop.example.test/WordPress',
    );
  });

  it('preserve www, non-www and a WordPress subdirectory as identity components', () => {
    expect(normalizeWooCommerceIdentity('https://www.shop.example.test/store/')).toBe(
      'https://www.shop.example.test/store',
    );
    expect(normalizeWooCommerceIdentity('https://shop.example.test/store/')).toBe(
      'https://shop.example.test/store',
    );
  });

  it('strips a DNS trailing dot while preserving the same canonical identity', () => {
    expect(normalizeWooCommerceIdentity('https://shop.example.test./')).toBe(
      'https://shop.example.test/',
    );
  });

  it.each([
    'http://shop.example.test/',
    'https://user:password@shop.example.test/',
    'https://shop.example.test:8443/',
    'https://shop.example.test/?x=1',
    'https://[fe80::1%25eth0]/',
  ])('rejects an identity that is not a plain HTTPS origin: %s', (input) => {
    expect(() => normalizeWooCommerceIdentity(input)).toThrow('invalid_url');
  });

  it('allows API query strings for request URLs but still requires HTTPS', () => {
    expect(
      parseWooCommerceRequestUrl('https://shop.example.test/wp-json/wc/v3/orders?page=1'),
    ).toBeInstanceOf(URL);
    expect(() => parseWooCommerceRequestUrl('http://shop.example.test/wp-json/')).toThrow(
      'invalid_url',
    );
  });

  it('lets the platform URL parser expose punycode without treating it as a measured local fact', () => {
    expect(normalizeWooCommerceIdentity('https://münich.example/')).toBe(
      'https://xn--mnich-kva.example/',
    );
  });
});
