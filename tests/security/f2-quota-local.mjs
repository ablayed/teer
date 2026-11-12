import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import {
  GENERATION_WINDOW_MS,
  recordGenerationUsage,
  reserveGeneration,
} from '../../lib/ia/generation-quota-core.ts';
import { startLocalRedis } from './local-redis.mjs';

let local;
let redis;
const identity = () => ({ userId: randomUUID(), merchantAccountId: randomUUID() });
before(async () => {
  local = await startLocalRedis();
  redis = {
    eval: (script, keys, args) => local.command(['EVAL', script, keys.length, ...keys, ...args]),
  };
});
after(async () => {
  await local?.stop();
});
const reserve = (actor, now, id = randomUUID()) => reserveGeneration(redis, actor, id, now);

test('user limit is 30 generations without any tool call', async () => {
  const actor = identity();
  const now = Date.now();
  for (let i = 0; i < 30; i++) assert.deepEqual(await reserve(actor, now), { ok: true });
  assert.deepEqual(await reserve(actor, now), { ok: false, reason: 'limited' });
  assert.deepEqual(await reserve(identity(), now), { ok: true });
});
test('tenant limit is shared and denied reservations do not consume the user quota', async () => {
  const actor = identity();
  const now = Date.now();
  for (let u = 0; u < 4; u++) {
    const user = { ...actor, userId: randomUUID() };
    for (let i = 0; i < 30; i++) assert.deepEqual(await reserve(user, now), { ok: true });
  }
  assert.deepEqual(await reserve(actor, now), { ok: false, reason: 'limited' });
  assert.equal(
    await local.command([
      'ZCARD',
      `ia:generation:{${actor.merchantAccountId}}:user:${actor.userId}`,
    ]),
    0,
  );
});
test('48 concurrent requests reserve exactly 30 slots atomically', async () => {
  const actor = identity();
  const now = Date.now();
  const results = await Promise.all(Array.from({ length: 48 }, () => reserve(actor, now)));
  assert.equal(results.filter((r) => r.ok).length, 30);
  assert.equal(results.filter((r) => !r.ok && r.reason === 'limited').length, 18);
});
test('concurrent users share exactly 120 tenant slots', async () => {
  const actor = identity();
  const users = Array.from({ length: 7 }, () => ({ ...actor, userId: randomUUID() }));
  const now = Date.now();
  const results = [];
  // Bounded local concurrency; seven users each request twenty generations.
  for (let wave = 0; wave < 10; wave++) {
    results.push(
      ...(await Promise.all(users.flatMap((user) => [reserve(user, now), reserve(user, now)]))),
    );
  }
  assert.equal(results.filter((r) => r.ok).length, 120);
  assert.equal(results.filter((r) => !r.ok && r.reason === 'limited').length, 20);
});

test('sliding window expires at the boundary and keys have bounded TTL', async () => {
  const actor = identity();
  const now = Date.now();
  for (let i = 0; i < 30; i++) await reserve(actor, now);
  assert.deepEqual(await reserve(actor, now + GENERATION_WINDOW_MS - 1), {
    ok: false,
    reason: 'limited',
  });
  assert.deepEqual(await reserve(actor, now + GENERATION_WINDOW_MS), { ok: true });
  const ttl = await local.command(['PTTL', `ia:generation:{${actor.merchantAccountId}}:tenant`]);
  assert.ok(ttl > 0 && ttl <= GENERATION_WINDOW_MS + 10000);
});
test('same request retried is idempotent at the limit', async () => {
  const actor = identity();
  const now = Date.now();
  const id = randomUUID();
  for (let i = 0; i < 29; i++) await reserve(actor, now);
  assert.deepEqual(await reserve(actor, now, id), { ok: true });
  assert.deepEqual(await reserve(actor, now, id), { ok: true });
  assert.equal(
    await local.command(['ZCARD', `ia:generation:{${actor.merchantAccountId}}:tenant`]),
    30,
  );
});
test('missing, failed or malformed Redis refuses generation', async () => {
  for (const backend of [
    null,
    {
      eval: async () => {
        throw new Error('synthetic failure');
      },
    },
    { eval: async () => '0' },
  ]) {
    assert.deepEqual(await reserveGeneration(backend, identity(), randomUUID()), {
      ok: false,
      reason: 'unavailable',
    });
  }
});
test('provider failure remains reserved; known tokens and unknown failures are distinct', async () => {
  const actor = identity();
  const now = Date.now();
  assert.deepEqual(await reserve(actor, now), { ok: true });
  assert.equal(await recordGenerationUsage(redis, actor, { failed: true }), true);
  assert.equal(
    await recordGenerationUsage(redis, actor, { failed: false, inputTokens: 13, outputTokens: 7 }),
    true,
  );
  assert.equal(
    await local.command(['ZCARD', `ia:generation:{${actor.merchantAccountId}}:tenant`]),
    1,
  );
  const key = `ia:usage:{${actor.merchantAccountId}}:${new Date().toISOString().slice(0, 10)}:tenant`;
  assert.deepEqual(
    await local.command([
      'HMGET',
      key,
      'failed_unknown_usage',
      'completed',
      'input_tokens',
      'output_tokens',
    ]),
    ['1', '1', '13', '7'],
  );
});
