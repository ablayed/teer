import { env } from '@/lib/env';
import * as Sentry from '@sentry/nextjs';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

type RateLimitPolicyConfig = {
  limit: number;
  prefix: string;
  window: `${number} ${'s' | 'm' | 'h' | 'd'}`;
};

const policyConfigs = {
  auth_login: {
    limit: 5,
    prefix: 'rl:auth:login',
    window: '60 s',
  },
  auth_signup: {
    limit: 3,
    prefix: 'rl:auth:signup',
    window: '1 h',
  },
  shopify_webhook: {
    limit: 600,
    prefix: 'rl:webhook:shopify',
    window: '60 s',
  },
} as const satisfies Record<string, RateLimitPolicyConfig>;

export type RateLimitPolicyName = keyof typeof policyConfigs;

const url = env.UPSTASH_REDIS_REST_URL;
const token = env.UPSTASH_REDIS_REST_TOKEN;

const redis = url && token ? new Redis({ url, token }) : null;

const limiters = redis
  ? (Object.fromEntries(
      Object.entries(policyConfigs).map(([name, config]) => [
        name,
        new Ratelimit({
          analytics: false,
          limiter: Ratelimit.slidingWindow(config.limit, config.window),
          prefix: config.prefix,
          redis,
        }),
      ]),
    ) as Record<RateLimitPolicyName, Ratelimit>)
  : null;

export function isRateLimitBackendConfigured(): boolean {
  return limiters !== null;
}

export async function checkRateLimit(
  name: RateLimitPolicyName,
  key: string,
): Promise<{ ok: boolean }> {
  if (!limiters) {
    return { ok: true };
  }

  try {
    const { success } = await limiters[name].limit(key);
    return { ok: success };
  } catch (error) {
    Sentry.captureException(error, { tags: { component: 'rate-limit', policy: name } });
    return { ok: true };
  }
}
