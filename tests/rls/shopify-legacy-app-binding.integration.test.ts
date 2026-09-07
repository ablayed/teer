import { createHmac } from 'node:crypto';
import type { Database } from '@/lib/supabase/database.types';
import { assertLocalSupabase } from '@/tests/e2e/helpers/assert-local-supabase';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const afterState = vi.hoisted(() => ({
  callbacks: [] as Promise<unknown>[],
}));

vi.mock('next/server', () => ({
  after(callback: () => Promise<unknown>) {
    afterState.callbacks.push(callback());
  },
}));

const APP_A_CLIENT_ID = 'conf-01c-app-a';
const APP_A_SECRET = 'conf-01c-secret-a';
const APP_B_CLIENT_ID = 'conf-01c-app-b';
const APP_B_SECRET = 'conf-01c-secret-b';
const SHOPIFY_ENV_KEYS = [
  'SHOPIFY_API_KEY',
  'SHOPIFY_API_SECRET',
  'SHOPIFY_PILOTE_API_KEY',
  'SHOPIFY_PILOTE_API_SECRET',
  'SHOPIFY_MARCHAND_API_KEY',
  'SHOPIFY_MARCHAND_API_SECRET',
  'SHOPIFY_KOBA_API_KEY',
  'SHOPIFY_KOBA_API_SECRET',
] as const;

type AdminClient = SupabaseClient<Database>;
type PostHandler = (request: Request) => Promise<Response>;
type Topic = 'customers/data_request' | 'customers/redact' | 'shop/redact';
type Scenario = 'header-absent' | 'header-unknown' | 'positive' | 'uninstalled';

type Fixture = {
  admin: AdminClient;
  userId: string;
  merchantAccountId: string;
  shopId: string;
  shopDomain: string;
  customerId: string;
  customerExternalId: string;
  orderId: string;
};

type EventRow = {
  id: string;
  status: string;
  last_error_code: string | null;
};

const previousShopifyEnv = new Map<string, string | undefined>();
let previousResendApiKey: string | undefined;
let postWebhook: PostHandler;
let supabaseUrl: string;
let serviceRoleKey: string;

function configureFictitiousApps(): void {
  for (const key of SHOPIFY_ENV_KEYS) {
    previousShopifyEnv.set(key, process.env[key]);
    delete process.env[key];
  }

  process.env.SHOPIFY_API_KEY = APP_A_CLIENT_ID;
  process.env.SHOPIFY_API_SECRET = APP_A_SECRET;
  process.env.SHOPIFY_PILOTE_API_KEY = APP_B_CLIENT_ID;
  process.env.SHOPIFY_PILOTE_API_SECRET = APP_B_SECRET;
  previousResendApiKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 'conf-01c-local-resend-placeholder';
}

function restoreFictitiousApps(): void {
  for (const key of SHOPIFY_ENV_KEYS) {
    const previous = previousShopifyEnv.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  if (previousResendApiKey === undefined) process.env.RESEND_API_KEY = undefined;
  else process.env.RESEND_API_KEY = previousResendApiKey;
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64');
}

async function createFixture(
  admin: AdminClient,
  scenario: Scenario,
  uninstalled: boolean,
): Promise<Fixture> {
  const suffix = crypto.randomUUID();
  const email = `conf-01c-${suffix}@example.test`;
  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email,
    password: 'conf-01c-local-only-password',
    email_confirm: true,
  });
  if (userError || !userData.user) throw userError ?? new Error('fixture user missing');

  const userId = userData.user.id;
  const { data: merchant, error: merchantError } = await admin
    .from('merchant_account')
    .select('id')
    .eq('owner_user_id', userId)
    .single();
  if (merchantError || !merchant) throw merchantError ?? new Error('fixture merchant missing');

  const { error: merchantNameError } = await admin
    .from('merchant_account')
    .update({ name: `CONF-01C ${scenario} ${suffix}` })
    .eq('id', merchant.id);
  if (merchantNameError) throw merchantNameError;

  const shopDomain = `conf-01c-${scenario}-${suffix}.myshopify.com`;
  const { data: shop, error: shopError } = await admin
    .from('shop')
    .insert({
      merchant_account_id: merchant.id,
      shop_domain: shopDomain,
      shopify_client_id: APP_B_CLIENT_ID,
      access_token_encrypted: 'conf-01c-local-token',
      scopes: 'read_orders,read_customers,read_products',
      status: uninstalled ? 'uninstalled' : 'active',
      uninstalled_at: uninstalled ? new Date().toISOString() : null,
    })
    .select('id')
    .single();
  if (shopError || !shop) throw shopError ?? new Error('fixture shop missing');

  const customerExternalId = `conf-01c-customer-${suffix}`;
  const { data: customer, error: customerError } = await admin
    .from('customer')
    .insert({
      merchant_account_id: merchant.id,
      shop_id: shop.id,
      shopify_customer_id: customerExternalId,
      full_name: 'Client CONF-01C',
      phone: '+221770000111',
      address: { marker: 'customer-pii' },
      shipping_address: { marker: 'customer-shipping-pii' },
    })
    .select('id')
    .single();
  if (customerError || !customer) throw customerError ?? new Error('fixture customer missing');

  const { data: order, error: orderError } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchant.id,
      shop_id: shop.id,
      customer_id: customer.id,
      shopify_order_id: `conf-01c-order-${suffix}`,
      order_number: `#CONF-01C-${suffix}`,
      total_amount: 15000,
      currency: 'XOF',
      order_state: 'open',
      call_state: 'to_call',
      delivery_state: 'unassigned',
      cash_state: 'not_due',
      shipping_address: { marker: 'order-shipping-pii' },
      note: 'order-pii',
      shopify_order_attributes: { marker: 'order-attributes-pii' },
      shopify_line_item_attributes: { marker: 'line-item-pii' },
    })
    .select('id')
    .single();
  if (orderError || !order) throw orderError ?? new Error('fixture order missing');

  const { error: addressError } = await admin.from('delivery_address').insert({
    merchant_account_id: merchant.id,
    shop_id: shop.id,
    customer_id: customer.id,
    order_id: order.id,
    quartier_commune: 'CONF-01C',
    telephone_principal: '+221770000112',
  });
  if (addressError) throw addressError;

  return {
    admin,
    userId,
    merchantAccountId: merchant.id,
    shopId: shop.id,
    shopDomain,
    customerId: customer.id,
    customerExternalId,
    orderId: order.id,
  };
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  const { data: artifacts } = await fixture.admin
    .from('shopify_dsar_artifact')
    .select('storage_path')
    .eq('merchant_account_id', fixture.merchantAccountId);
  const paths = (artifacts ?? [])
    .map((artifact) => artifact.storage_path)
    .filter((path): path is string => typeof path === 'string');
  if (paths.length > 0) {
    await fixture.admin.storage.from('shopify-dsar').remove(paths);
  }
  await fixture.admin.auth.admin.deleteUser(fixture.userId);
}

function buildRequest({
  topic,
  shopDomain,
  customerExternalId,
  webhookId,
  secret,
  header,
}: {
  topic: Topic;
  shopDomain: string;
  customerExternalId: string;
  webhookId: string;
  secret: string;
  header: 'absent' | 'unknown' | 'shop';
}): Request {
  const body = JSON.stringify({
    shop_domain: shopDomain,
    ...(topic === 'customers/data_request' || topic === 'customers/redact'
      ? { customer: { id: customerExternalId } }
      : {}),
  });
  const headers = new Headers({
    'content-type': 'application/json',
    'x-shopify-hmac-sha256': sign(body, secret),
    'x-shopify-topic': topic,
    'x-shopify-webhook-id': webhookId,
    'x-shopify-triggered-at': '2026-09-07T10:00:00.000Z',
  });
  if (header === 'shop') headers.set('x-shopify-shop-domain', shopDomain);
  if (header === 'unknown') headers.set('x-shopify-shop-domain', `unknown-${shopDomain}`);

  return new Request('http://localhost:3000/api/shopify/webhooks', {
    method: 'POST',
    headers,
    body,
  });
}

async function waitForAfterCallbacks(): Promise<void> {
  const callbacks = afterState.callbacks.splice(0);
  await Promise.all(callbacks);
}

async function getEvent(admin: AdminClient, webhookId: string): Promise<EventRow> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { data, error } = await admin
      .from('webhook_event')
      .select('id, status, last_error_code')
      .eq('shopify_webhook_id', webhookId)
      .maybeSingle();
    if (error) throw error;
    if (
      data &&
      (data.status === 'done' || data.status === 'terminal' || data.status === 'retryable')
    ) {
      return data;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`webhook event not finalized: ${webhookId}`);
}

async function assertTopicEffect(
  fixture: Fixture,
  topic: Topic,
  shouldProcess: boolean,
  event: EventRow,
): Promise<void> {
  const { data: customer } = await fixture.admin
    .from('customer')
    .select('full_name, phone, address, shipping_address')
    .eq('id', fixture.customerId)
    .single();
  const { data: order } = await fixture.admin
    .from('orders')
    .select('shipping_address, note, shopify_order_attributes, shopify_line_item_attributes')
    .eq('id', fixture.orderId)
    .single();
  const { count: addressCount } = await fixture.admin
    .from('delivery_address')
    .select('id', { count: 'exact', head: true })
    .eq('merchant_account_id', fixture.merchantAccountId)
    .eq('shop_id', fixture.shopId);
  const { count: tombstoneCount } = await fixture.admin
    .from('shopify_customer_redaction_tombstone')
    .select('id', { count: 'exact', head: true })
    .eq('merchant_account_id', fixture.merchantAccountId)
    .eq('shop_id', fixture.shopId)
    .eq('shopify_customer_id', fixture.customerExternalId);
  const { data: artifacts, count: artifactCount } = await fixture.admin
    .from('shopify_dsar_artifact')
    .select('status, storage_path, byte_size', { count: 'exact' })
    .eq('merchant_account_id', fixture.merchantAccountId)
    .eq('shop_id', fixture.shopId);
  const { count: auditCount } = await fixture.admin
    .from('audit_log')
    .select('id', { count: 'exact', head: true })
    .eq('merchant_account_id', fixture.merchantAccountId)
    .eq('action', `gdpr.${topic}`)
    .eq('resource_id', fixture.shopId);

  if (topic === 'customers/data_request') {
    expect(artifactCount).toBe(shouldProcess ? 1 : 0);
    expect(auditCount).toBe(shouldProcess ? 1 : 0);
    if (shouldProcess) {
      const artifact = artifacts?.[0];
      expect(artifact?.status).toBe('ready');
      expect(artifact?.byte_size).toBeGreaterThan(0);
      const { data: file, error: storageError } = await fixture.admin.storage
        .from('shopify-dsar')
        .download(artifact?.storage_path ?? '');
      expect(storageError).toBeNull();
      expect(file).not.toBeNull();
    }
  } else if (shouldProcess) {
    expect(customer).toMatchObject({ full_name: '[client supprimé]', phone: null });
    expect(order).toMatchObject({
      shipping_address: null,
      note: null,
      shopify_order_attributes: null,
      shopify_line_item_attributes: null,
    });
    expect(addressCount).toBe(0);
    expect(tombstoneCount).toBe(1);
    expect(auditCount).toBe(1);
  } else {
    expect(customer).toMatchObject({ full_name: 'Client CONF-01C', phone: '+221770000111' });
    expect(order?.shipping_address).not.toBeNull();
    expect(order?.note).toBe('order-pii');
    expect(addressCount).toBe(1);
    expect(tombstoneCount).toBe(0);
    expect(auditCount).toBe(0);
  }

  if (shouldProcess) {
    expect(event.status).toBe('done');
    expect(event.last_error_code).toBeNull();
  } else {
    expect(event.status).toBe('terminal');
    expect(event.last_error_code).toBe('gdpr_shop_domain_mismatch');
  }
}

describe('CONF-01C — liaison app validante / boutique sur le endpoint legacy', () => {
  beforeAll(async () => {
    configureFictitiousApps();
    supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
    serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
    assertLocalSupabase(supabaseUrl);
    if (!serviceRoleKey) throw new Error('CONF-01C requires the local Supabase service role');
    vi.resetModules();
    const route = await import('@/app/api/shopify/webhooks/route');
    postWebhook = route.POST;
  });

  afterAll(() => {
    restoreFictitiousApps();
  });

  describe.each([
    ['header absent', 'header-absent', 'absent', APP_A_SECRET, false],
    ['header unknown', 'header-unknown', 'unknown', APP_A_SECRET, false],
    ['B positive', 'positive', 'shop', APP_B_SECRET, true],
    ['B uninstalled', 'uninstalled', 'shop', APP_B_SECRET, true],
  ] as const)('%s', (_label, scenario, header, secret, shouldProcess) => {
    it.each(['customers/data_request', 'customers/redact', 'shop/redact'] as const)(
      '%s : le résultat métier reste conforme au verdict de sécurité',
      async (topic) => {
        const admin = createClient<Database>(supabaseUrl, serviceRoleKey, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        const fixture = await createFixture(admin, scenario, scenario === 'uninstalled');
        const webhookId = `conf-01c-${scenario}-${topic.replaceAll('/', '-')}-${crypto.randomUUID()}`;

        try {
          const response = await postWebhook(
            buildRequest({
              topic,
              shopDomain: fixture.shopDomain,
              customerExternalId: fixture.customerExternalId,
              webhookId,
              secret,
              header,
            }),
          );
          expect(response.status).toBe(200);
          await waitForAfterCallbacks();
          const event = await getEvent(admin, webhookId);
          await assertTopicEffect(fixture, topic, shouldProcess, event);
        } finally {
          await cleanupFixture(fixture);
        }
      },
    );
  });
});
