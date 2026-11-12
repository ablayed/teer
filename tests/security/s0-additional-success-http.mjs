import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

// Positive functional compatibility only: matching identities and valid test signatures.
const require = createRequire(import.meta.url);
const database = new URL(process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321');
assert.equal(database.origin, 'http://127.0.0.1:54321');
const origin = 'http://127.0.0.1:3013';
const appId = 'synthetic-success-compat';
const appSecret = randomBytes(32).toString('hex');
const admin = createClient(database.href, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
let userId;
let tenantId;
let server;
async function fixture(query) {
  const result = await query;
  assert.ok(!result.error, 'synthetic fixture operation must succeed');
  return result.data;
}
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('local functional operation did not settle');
}
before(async () => {
  const created = await fixture(
    admin.auth.admin.createUser({
      email: `compat-${randomUUID()}@example.test`,
      password: randomBytes(32).toString('hex'),
      email_confirm: true,
    }),
  );
  userId = created.user.id;
  const member = await fixture(
    admin.from('merchant_member').select('merchant_account_id').eq('user_id', userId).single(),
  );
  tenantId = member.merchant_account_id;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    VERCEL_ENV: 'preview',
    SHOPIFY_API_KEY: appId,
    SHOPIFY_API_SECRET: appSecret,
    RESEND_API_KEY: 'local-disabled',
    NEXT_TELEMETRY_DISABLED: '1',
    NODE_OPTIONS: `--require=${fileURLToPath(new URL('./s0-provider-preload.cjs', import.meta.url))}`,
  };
  for (const key of Object.keys(env)) {
    if (
      /^SHOPIFY_(PILOTE|MARCHAND|KOBA|TEER_PUBLIC)_API_(KEY|SECRET)$/.test(key) ||
      /^(SENTRY_|NEXT_PUBLIC_SENTRY_|POSTHOG_|UPSTASH_)/.test(key)
    )
      delete env[key];
  }
  server = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', '3013'], {
    env,
    stdio: 'ignore',
    windowsHide: true,
  });
  await until(async () => {
    try {
      return (await fetch(`${origin}/api/shopify/webhooks`, { redirect: 'manual' })).status === 405;
    } catch {
      return false;
    }
  });
});
after(async () => {
  server?.kill();
  if (tenantId) {
    const artifacts = await admin
      .from('shopify_dsar_artifact')
      .select('storage_path')
      .eq('merchant_account_id', tenantId);
    const paths = (artifacts.data ?? []).map((row) => row.storage_path).filter(Boolean);
    if (paths.length) await admin.storage.from('shopify-dsar').remove(paths);
    await admin.from('shopify_dsar_artifact').delete().eq('merchant_account_id', tenantId);
    await admin.from('webhook_event').delete().eq('merchant_account_id', tenantId);
    await admin.from('merchant_account').delete().eq('id', tenantId);
  }
  if (userId) await admin.auth.admin.deleteUser(userId);
});

for (const encoding of ['identity', 'gzip']) {
  for (const family of ['ingest', 'compliance']) {
    test(`S0 successful ${family} ${encoding}: valid signature, empty 200 and durable effect`, async () => {
      const domain = `compat-${randomUUID()}.myshopify.com`;
      const shop = await fixture(
        admin
          .from('shop')
          .insert({
            merchant_account_id: tenantId,
            shop_domain: domain,
            store_kind: 'shopify',
            shopify_client_id: appId,
            status: 'active',
            credentials_acquired_at: new Date(Date.now() - 120000).toISOString(),
          })
          .select('id')
          .single(),
      );
      const connection = await fixture(
        admin
          .from('store_connection')
          .insert({
            merchant_account_id: tenantId,
            shop_id: shop.id,
            platform: 'shopify',
            external_identifier: domain,
            platform_app_id: appId,
            status: 'active',
          })
          .select('id')
          .single(),
      );
      let route = '/api/shopify/webhooks';
      let topic = 'customers/data_request';
      const customerId = String(randomInt(1000000, 2147483647));
      if (family === 'ingest') {
        const publicId = randomBytes(16).toString('base64url');
        const secret = randomBytes(32).toString('base64url');
        await fixture(
          admin.from('store_connection_webhook_token').insert({
            store_connection_id: connection.id,
            public_id: publicId,
            secret_hash: createHash('sha256').update(secret).digest('hex'),
          }),
        );
        route = `/api/shopify/ingest/${publicId}.${secret}`;
        topic = 'app/uninstalled';
      } else {
        await fixture(
          admin.from('customer').insert({
            merchant_account_id: tenantId,
            shop_id: shop.id,
            shopify_customer_id: customerId,
            full_name: 'Synthetic compatibility customer',
          }),
        );
      }
      const raw = JSON.stringify({
        shop_domain: domain,
        domain,
        myshopify_domain: domain,
        ...(family === 'compliance' ? { customer: { id: customerId } } : {}),
      });
      const webhookId = randomUUID();
      for (let delivery = 0; delivery < 2; delivery++) {
        const response = await fetch(new URL(route, origin), {
          method: 'POST',
          redirect: 'manual',
          headers: {
            'content-type': 'application/json',
            'accept-encoding': encoding,
            'x-shopify-topic': topic,
            'x-shopify-shop-domain': domain,
            'x-shopify-webhook-id': webhookId,
            'x-shopify-triggered-at': new Date().toISOString(),
            'x-shopify-hmac-sha256': createHmac('sha256', appSecret).update(raw).digest('base64'),
          },
          body: raw,
          signal: AbortSignal.timeout(15000),
        });
        assert.equal(response.status, 200);
        assert.equal(await response.text(), '');
        assert.equal(response.headers.get('x-middleware-set-cookie'), null);
      }
      await until(async () => {
        const event = await admin
          .from('webhook_event')
          .select('status')
          .eq('shopify_webhook_id', webhookId)
          .maybeSingle();
        return event.data?.status === 'done';
      });
      const event = await fixture(
        admin
          .from('webhook_event')
          .select('id', { count: 'exact' })
          .eq('shopify_webhook_id', webhookId)
          .single(),
      );
      if (family === 'ingest') {
        const state = await fixture(admin.from('shop').select('status').eq('id', shop.id).single());
        assert.equal(state.status, 'uninstalled');
      } else {
        const artifact = await fixture(
          admin
            .from('shopify_dsar_artifact')
            .select('status')
            .eq('webhook_event_id', event.id)
            .single(),
        );
        assert.equal(artifact.status, 'ready');
      }
    });
  }
}
