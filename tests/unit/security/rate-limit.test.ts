import { afterEach, describe, expect, it, vi } from 'vitest';

describe('checkRateLimit', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('fails open when Upstash is not configured', async () => {
    vi.doMock('@/lib/env', () => ({
      env: {
        UPSTASH_REDIS_REST_TOKEN: undefined,
        UPSTASH_REDIS_REST_URL: undefined,
      },
    }));
    vi.doMock('@sentry/nextjs', () => ({
      captureException: vi.fn(),
    }));
    vi.doMock('@upstash/redis', () => ({
      Redis: vi.fn(),
    }));
    vi.doMock('@upstash/ratelimit', () => ({
      Ratelimit: Object.assign(vi.fn(), {
        slidingWindow: vi.fn(),
      }),
    }));

    const { checkRateLimit, isRateLimitBackendConfigured } = await import(
      '@/lib/security/rate-limit'
    );

    await expect(
      checkRateLimit('shopify_webhook', 'webhook:boutique-a.myshopify.com'),
    ).resolves.toEqual({ ok: true });
    expect(isRateLimitBackendConfigured()).toBe(false);
  });

  it('isolates buckets per key', async () => {
    vi.doMock('@/lib/env', () => ({
      env: {
        UPSTASH_REDIS_REST_TOKEN: 'token-test',
        UPSTASH_REDIS_REST_URL: 'https://upstash.example.test',
      },
    }));
    vi.doMock('@sentry/nextjs', () => ({
      captureException: vi.fn(),
    }));
    vi.doMock('@upstash/redis', () => ({
      Redis: vi.fn().mockImplementation(() => ({})),
    }));
    vi.doMock('@upstash/ratelimit', () => {
      const buckets = new Map<string, number>();
      const limit = vi.fn(async (key: string) => {
        const next = (buckets.get(key) ?? 0) + 1;
        buckets.set(key, next);
        return { success: next <= 1 };
      });

      return {
        Ratelimit: Object.assign(
          vi.fn().mockImplementation(() => ({
            limit,
          })),
          {
            slidingWindow: vi.fn(),
          },
        ),
      };
    });

    const { checkRateLimit } = await import('@/lib/security/rate-limit');

    await expect(
      checkRateLimit('shopify_webhook', 'webhook:boutique-a.myshopify.com'),
    ).resolves.toEqual({ ok: true });
    await expect(
      checkRateLimit('shopify_webhook', 'webhook:boutique-b.myshopify.com'),
    ).resolves.toEqual({ ok: true });
    await expect(
      checkRateLimit('shopify_webhook', 'webhook:boutique-a.myshopify.com'),
    ).resolves.toEqual({ ok: false });
  });
});
