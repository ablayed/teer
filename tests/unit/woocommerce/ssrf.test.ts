import {
  type ResolvedAddress,
  isForbiddenAddress,
  validateAndPinHttpsTarget,
} from '@/lib/woocommerce/ssrf';
import { describe, expect, it, vi } from 'vitest';

const address = (value: string, family: 4 | 6): ResolvedAddress => ({ address: value, family });
const resolverFor = (...answers: ResolvedAddress[]) => vi.fn(async () => answers);

describe('WooCommerce SSRF guard', () => {
  it('resolves all A/AAAA records, rejects a mixed safe/forbidden set, and pins a safe set', async () => {
    await expect(
      validateAndPinHttpsTarget(
        'https://shop.example.test/',
        resolverFor(address('93.184.216.34', 4), address('127.0.0.1', 4)),
      ),
    ).rejects.toMatchObject({ code: 'ssrf_rejected' });

    const resolver = resolverFor(address('93.184.216.34', 4), address('2001:4860:4860::8888', 6));
    const pinned = await validateAndPinHttpsTarget('HTTPS://Shop.Example.test./', resolver);
    expect(resolver).toHaveBeenCalledWith('shop.example.test');
    expect(pinned.address).toEqual(address('93.184.216.34', 4));
    expect(pinned.hostname).toBe('shop.example.test.');
    expect(pinned.url.hostname).toBe('shop.example.test.');
  });

  it.each([
    'http://shop.example.test/',
    'https://user:password@shop.example.test/',
    'https://shop.example.test:8443/',
  ])('rejects a non-callable destination before DNS: %s', async (input) => {
    await expect(
      validateAndPinHttpsTarget(input, resolverFor(address('93.184.216.34', 4))),
    ).rejects.toMatchObject({ code: 'ssrf_rejected' });
  });

  it.each([
    ['0.0.0.0', 4],
    ['10.0.0.1', 4],
    ['100.64.0.1', 4],
    ['127.0.0.1', 4],
    ['169.254.1.1', 4],
    ['172.16.0.1', 4],
    ['192.0.0.1', 4],
    ['192.0.2.1', 4],
    ['192.88.99.1', 4],
    ['192.168.1.1', 4],
    ['198.18.0.1', 4],
    ['198.51.100.1', 4],
    ['203.0.113.1', 4],
    ['224.0.0.1', 4],
    ['::', 6],
    ['::1', 6],
    ['fc00::1', 6],
    ['fe80::1', 6],
    ['ff02::1', 6],
    ['2001:db8::1', 6],
    ['2001:1::1', 6],
    ['::ffff:127.0.0.1', 6],
    ['::ffff:7f00:1', 6],
  ] as const)('rejects forbidden address %s', (value, family) => {
    expect(isForbiddenAddress(value, family)).toBe(true);
  });

  it('accepts a public IPv4 and IPv6 address', () => {
    expect(isForbiddenAddress('93.184.216.34', 4)).toBe(false);
    expect(isForbiddenAddress('2001:4860:4860::8888', 6)).toBe(false);
  });

  it.each(['2130706433', '0x7f000001', '0177.0.0.1'])(
    'rejects numeric loopback spelling %s after URL parsing',
    async (host) => {
      await expect(
        validateAndPinHttpsTarget(`https://${host}/`, resolverFor(address('127.0.0.1', 4))),
      ).rejects.toMatchObject({ code: 'ssrf_rejected' });
    },
  );

  it('rejects an IPv6 zone and asks DNS for a trailing-dot hostname without the dot', async () => {
    await expect(
      validateAndPinHttpsTarget(
        'https://[fe80::1%25eth0]/',
        resolverFor(address('93.184.216.34', 4)),
      ),
    ).rejects.toMatchObject({ code: 'ssrf_rejected' });
    const resolver = resolverFor(address('93.184.216.34', 4));
    await validateAndPinHttpsTarget('https://example.test./', resolver);
    expect(resolver).toHaveBeenCalledWith('example.test');
  });

  it('rejects a DNS failure without exposing the resolver error', async () => {
    const resolver = vi.fn(async () => {
      throw new Error('resolved 127.0.0.1');
    });
    await expect(
      validateAndPinHttpsTarget('https://shop.example.test/', resolver),
    ).rejects.toMatchObject({ code: 'dns_failed' });
    await expect(
      validateAndPinHttpsTarget('https://shop.example.test/', resolver),
    ).rejects.not.toThrow('127.0.0.1');
  });
});
