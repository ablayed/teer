export const GENERATION_WINDOW_MS = 60_000;
export const USER_GENERATION_LIMIT = 30;
export const TENANT_GENERATION_LIMIT = 120;

// All accessed keys are declared; shared hash tag is compatible with Redis Cluster.
export const RESERVE_GENERATION_LUA = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
for i = 1, 2 do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now - window)
end
if redis.call('ZSCORE', KEYS[1], ARGV[5]) and redis.call('ZSCORE', KEYS[2], ARGV[5]) then
  return 0
end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) or redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[4]) then
  return 1
end
for i = 1, 2 do
  redis.call('ZADD', KEYS[i], now, ARGV[5])
  redis.call('PEXPIRE', KEYS[i], window + 10000)
end
return 0
`;

export type QuotaRedis = {
  eval: (script: string, keys: string[], args: (string | number)[]) => Promise<unknown>;
};
export type QuotaIdentity = { userId: string; merchantAccountId: string };
export type GenerationReservation = { ok: true } | { ok: false; reason: 'limited' | 'unavailable' };

export async function reserveGeneration(
  redis: QuotaRedis | null,
  identity: QuotaIdentity,
  requestId: string,
  now = Date.now(),
): Promise<GenerationReservation> {
  if (!redis) return { ok: false, reason: 'unavailable' };
  const prefix = `ia:generation:{${identity.merchantAccountId}}`;
  try {
    const result = await redis.eval(
      RESERVE_GENERATION_LUA,
      [`${prefix}:user:${identity.userId}`, `${prefix}:tenant`],
      [now, GENERATION_WINDOW_MS, USER_GENERATION_LIMIT, TENANT_GENERATION_LIMIT, requestId],
    );
    if (result === 0) return { ok: true };
    if (result === 1) return { ok: false, reason: 'limited' };
  } catch {
    // Never forward backend errors or credentials to callers/telemetry.
  }
  return { ok: false, reason: 'unavailable' };
}

export const RECORD_USAGE_LUA = `
for i = 1, 2 do
  redis.call('HINCRBY', KEYS[i], 'input_tokens', ARGV[1])
  redis.call('HINCRBY', KEYS[i], 'output_tokens', ARGV[2])
  redis.call('HINCRBY', KEYS[i], ARGV[3], 1)
  redis.call('EXPIRE', KEYS[i], 2678400)
end
return 0
`;

export async function recordGenerationUsage(
  redis: QuotaRedis | null,
  identity: QuotaIdentity,
  usage: { inputTokens?: number; outputTokens?: number; failed: boolean },
): Promise<boolean> {
  if (!redis) return false;
  const prefix = `ia:usage:{${identity.merchantAccountId}}:${new Date().toISOString().slice(0, 10)}`;
  const valid = (n: number | undefined) => Number.isSafeInteger(n) && (n ?? -1) >= 0;
  const known = valid(usage.inputTokens) && valid(usage.outputTokens);
  try {
    return (
      (await redis.eval(
        RECORD_USAGE_LUA,
        [`${prefix}:user:${identity.userId}`, `${prefix}:tenant`],
        [
          known ? (usage.inputTokens ?? 0) : 0,
          known ? (usage.outputTokens ?? 0) : 0,
          usage.failed ? 'failed_unknown_usage' : known ? 'completed' : 'completed_unknown_usage',
        ],
      )) === 0
    );
  } catch {
    return false;
  }
}
