import { randomUUID } from 'node:crypto';
import { env } from '@/lib/env';
import {
  type QuotaIdentity,
  recordGenerationUsage,
  reserveGeneration,
} from '@/lib/ia/generation-quota-core';
import { Redis } from '@upstash/redis';

const redis =
  env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: env.UPSTASH_REDIS_REST_URL,
        token: env.UPSTASH_REDIS_REST_TOKEN,
        retry: { retries: 1, backoff: () => 100 },
        signal: () => AbortSignal.timeout(2000),
        enableAutoPipelining: false,
      })
    : null;

export function reserveIaGeneration(identity: QuotaIdentity) {
  return reserveGeneration(redis, identity, randomUUID());
}

export function recordIaGenerationUsage(
  identity: QuotaIdentity,
  usage: { inputTokens?: number; outputTokens?: number; failed: boolean },
) {
  return recordGenerationUsage(redis, identity, usage);
}
