import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { startLocalRedis } from './local-redis.mjs';

const require = createRequire(import.meta.url);
const databaseOrigin = new URL(process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321');
assert.equal(databaseOrigin.hostname, '127.0.0.1');
assert.equal(databaseOrigin.port, '54321');
const origin = 'http://127.0.0.1:3008';
const secret = randomBytes(32).toString('hex');
const appId = 'synthetic-s0-app';
const domain = `s0-${randomUUID()}.myshopify.com`;
const admin = createClient(databaseOrigin.href, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
let userId;
let shopId;
let connectionId;
let conversationId;
let server;
let localRedis;
const jar = new Map();

async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('local condition did not settle');
}

before(async () => {
  localRedis = await startLocalRedis();
  const email = `s0-${randomUUID()}@example.test`;
  const password = randomBytes(32).toString('hex');
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.equal(created.error, null);
  userId = created.data.user.id;
  const membership = await admin
    .from('merchant_member')
    .select('merchant_account_id')
    .eq('user_id', userId)
    .single();
  assert.equal(membership.error, null);
  const tenantId = membership.data.merchant_account_id;
  const shop = await admin
    .from('shop')
    .select('id')
    .eq('merchant_account_id', tenantId)
    .eq('is_default', true)
    .single();
  assert.equal(shop.error, null);
  shopId = shop.data.id;
  const updated = await admin
    .from('shop')
    .update({
      shop_domain: domain,
      store_kind: 'shopify',
      shopify_client_id: appId,
      status: 'active',
      credentials_acquired_at: new Date(Date.now() - 120000).toISOString(),
    })
    .eq('id', shopId);
  assert.equal(updated.error, null);
  const connection = await admin
    .from('store_connection')
    .insert({
      merchant_account_id: tenantId,
      shop_id: shopId,
      platform: 'shopify',
      external_identifier: domain,
      platform_app_id: appId,
      status: 'active',
    })
    .select('id')
    .single();
  assert.equal(connection.error, null);
  connectionId = connection.data.id;
  const client = createServerClient(
    databaseOrigin.href,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        setAll: (values) => {
          for (const { name, value } of values) jar.set(name, value);
        },
      },
    },
  );
  const signedIn = await client.auth.signInWithPassword({ email, password });
  assert.equal(signedIn.error, null);
  const conversation = await client
    .from('ia_conversation')
    .insert({ merchant_account_id: tenantId, user_id: userId })
    .select('id')
    .single();
  assert.equal(conversation.error, null);
  conversationId = conversation.data.id;
  const env = {
    ...process.env,
    VERCEL_ENV: 'preview',
    NODE_ENV: 'production',
    NEXT_PUBLIC_SUPABASE_URL: databaseOrigin.href,
    SUPABASE_URL: databaseOrigin.href,
    SHOPIFY_API_KEY: appId,
    SHOPIFY_API_SECRET: secret,
    GROQ_API_KEY: randomBytes(24).toString('hex'),
    RESEND_API_KEY: 'local-disabled',
    NEXT_TELEMETRY_DISABLED: '1',
    NODE_OPTIONS: `--require=${fileURLToPath(new URL('./s0-provider-preload.cjs', import.meta.url))}`,
  };
  for (const name of Object.keys(env)) {
    if (
      /^SHOPIFY_(PILOTE|MARCHAND|KOBA|TEER_PUBLIC)_API_(KEY|SECRET)$/.test(name) ||
      /^(UPSTASH_|SENTRY_|NEXT_PUBLIC_SENTRY_|POSTHOG_)/.test(name)
    )
      delete env[name];
  }
  env.UPSTASH_REDIS_REST_URL = localRedis.url;
  env.UPSTASH_REDIS_REST_TOKEN = localRedis.token;
  server = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', '3008'], {
    env,
    stdio: 'ignore',
    windowsHide: true,
  });
  await until(async () => {
    try {
      return (
        (await fetch(`${origin}/api/shopify/webhooks`, { method: 'POST', body: '{}' })).status ===
        401
      );
    } catch {
      return false;
    }
  });
});

after(async () => {
  server?.kill();
  await localRedis?.stop();
  jar.clear();
  await admin.from('webhook_event').delete().eq('shop_domain', domain);
  if (connectionId) await admin.from('store_connection').delete().eq('id', connectionId);
  if (userId) await admin.auth.admin.deleteUser(userId);
});

for (const encoding of ['identity', 'gzip']) {
  test(`signed uninstall ${encoding}: empty 200, real SQL effect and idempotent replay`, async () => {
    assert.equal(
      (await admin.from('shop').update({ status: 'active', uninstalled_at: null }).eq('id', shopId))
        .error,
      null,
    );
    assert.equal(
      (
        await admin
          .from('store_connection')
          .update({ status: 'active', uninstalled_at: null })
          .eq('id', connectionId)
      ).error,
      null,
    );
    const raw = JSON.stringify({ id: 12345, myshopify_domain: domain });
    const webhookId = randomUUID();
    const headers = {
      'content-type': 'application/json',
      'accept-encoding': encoding,
      'x-shopify-topic': 'app/uninstalled',
      'x-shopify-shop-domain': domain,
      'x-shopify-hmac-sha256': createHmac('sha256', secret).update(raw).digest('base64'),
      'x-shopify-webhook-id': webhookId,
      'x-shopify-triggered-at': new Date().toISOString(),
    };
    for (let delivery = 0; delivery < 2; delivery++) {
      const response = await fetch(`${origin}/api/shopify/webhooks`, {
        method: 'POST',
        headers,
        body: raw,
      });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), '');
      assert.equal(response.headers.get('x-middleware-set-cookie'), null);
      await until(
        async () =>
          (await admin.from('shop').select('status').eq('id', shopId).single()).data?.status ===
          'uninstalled',
      );
    }
    const receipts = await admin
      .from('webhook_event')
      .select('id', { count: 'exact' })
      .eq('shopify_webhook_id', webhookId);
    assert.equal(receipts.error, null);
    assert.equal(receipts.count, 1);
  });
  test(`authenticated AI ${encoding}: incremental SSE through real route, local provider double`, async () => {
    const response = await fetch(`${origin}/api/assistant/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept-encoding': encoding,
        cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
      },
      body: JSON.stringify({
        conversationId,
        messages: [{ id: 'synthetic', role: 'user', parts: [{ type: 'text', text: 'Bonjour' }] }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const first = await reader.read();
    const firstReadAt = Date.now();
    assert.equal(first.done, false);
    const decoder = new TextDecoder();
    let output = decoder.decode(first.value, { stream: true });
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value, { stream: true });
    }
    output += decoder.decode();
    assert.match(output, /Bonjour/);
    assert.match(output, /\[DONE\]/);
    const finishedAt = Number(output.match(/LOCAL_STREAM_END_(\d+)/)?.[1]);
    assert.ok(Number.isFinite(finishedAt));
    assert.ok(firstReadAt < finishedAt, 'first application chunk must precede provider completion');
  });
}
