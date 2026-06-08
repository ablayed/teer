import {
  isShopifyThrottleError,
  throttleBackoffDelayMs,
  withShopifyThrottleBackoff,
} from '@/lib/shopify/bulk';
import { describe, expect, it, vi } from 'vitest';

describe('withShopifyThrottleBackoff', () => {
  it('reessaie avec backoff exponentiel sur THROTTLED', async () => {
    const sleep = vi.fn(async () => undefined);
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('Shopify GraphQL request was throttled: slow down'))
      .mockRejectedValueOnce(new Error('Shopify GraphQL request was throttled: slow down'))
      .mockResolvedValueOnce('ok');

    await expect(
      withShopifyThrottleBackoff(operation, {
        baseDelayMs: 250,
        maxRetries: 4,
        sleep,
      }),
    ).resolves.toBe('ok');

    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 250);
    expect(sleep).toHaveBeenNthCalledWith(2, 500);
  });

  it('ne masque pas une erreur non throttle', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('Shopify GraphQL access denied'));

    await expect(withShopifyThrottleBackoff(operation)).rejects.toThrow(
      'Shopify GraphQL access denied',
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe('helpers throttle Shopify', () => {
  it('detecte THROTTLED dans le message normalise', () => {
    expect(isShopifyThrottleError(new Error('Shopify GraphQL request was throttled'))).toBe(true);
    expect(isShopifyThrottleError(new Error('Autre erreur'))).toBe(false);
  });

  it('calcule le delai exponentiel attendu', () => {
    expect(throttleBackoffDelayMs(0, 1_000)).toBe(1_000);
    expect(throttleBackoffDelayMs(1, 1_000)).toBe(2_000);
    expect(throttleBackoffDelayMs(2, 1_000)).toBe(4_000);
  });
});
