/**
 * Reprise interne des webhooks Shopify (lib/shopify/webhook-replay.ts).
 *
 * Ce qui est RÉEL : la route `POST /api/shopify/webhooks` (HMAC, enregistrement, réponse 200,
 * traitement après la réponse), le cœur partagé, `replayPendingShopifyWebhooks`, la base locale,
 * PostgREST, le stockage, les RPC `claim_shopify_webhook_events` et `finish_shopify_webhook_event`.
 * Ce qui est SUBSTITUÉ, et pourquoi : `after()` de Next (les rappels sont collectés puis attendus),
 * et la fabrique du client service-role, qui rend le VRAI client enveloppé d'un injecteur de
 * pannes : une écriture nommée échoue N fois, puis repasse. Aucun résultat de la base n'est simulé.
 * « Le temps passe » n'est jamais simulé par une horloge : l'échéance de l'événement est reculée
 * en base, et la reprise tourne à l'heure réelle.
 *
 * Propriétés verrouillées :
 *   - réponse 200, traitement en panne, AUCUNE nouvelle livraison, reprise réussie (RGPD, commande) ;
 *   - l'erreur d'origine est gardée : le code durable de l'événement porte son empreinte ;
 *   - une reprise rejouée n'écrit rien de plus ; deux reprises concurrentes : un seul traitement ;
 *   - une panne survenue APRÈS une écriture partielle ne produit ni doublon ni perte ;
 *   - bail non expiré, marge d'horloge, plafond de tentatives, fenêtre d'âge, sujet non repris :
 *     l'événement reste en l'état ;
 *   - une suppression de boutique n'est jamais reprise seule sur une boutique redevenue active ;
 *   - `orders/create` et `orders/updated` arrivées ensemble sur une commande neuve : deux succès,
 *     une commande, ses lignes une fois, la charge la plus récente en base ;
 *   - une charge de commande déjà appliquée, reprise, est écartée sans écriture.
 *
 * D'autres suites écrivent dans `webhook_event` pendant celle-ci : chaque assertion porte sur les
 * événements de cette suite, jamais sur un total.
 */

import { createHmac, randomUUID } from 'node:crypto';
import type { Database } from '@/lib/supabase/database.types';
import { assertLocalSupabase } from '@/tests/e2e/helpers/assert-local-supabase';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  callbacks: [] as Promise<unknown>[],
  faultCode: '08006',
  insertFaults: new Map<string, number>(),
  rpcCalls: [] as string[],
  rpcFaults: new Map<string, number>(),
  // Retient UN appel d'une RPC nommée, pour une commande donnée, jusqu'à `release` : l'entrelacement
  // d'une reprise ancienne et d'une livraison plus récente n'est alors pas laissé au hasard.
  gate: null as null | {
    entered: () => void;
    orderId: string;
    release: Promise<void>;
    // Nom d'une RPC, ou 'orders.update' pour l'écriture directe d'une commande.
    rpc: string;
    // 'orders.update' : l'écriture portant cette date de charge (ms).
    updatedAtMs: number;
    used: boolean;
  },
}));

const fault = () => ({
  code: harness.faultCode,
  details: null,
  hint: null,
  message: 'panne injectée',
});

// Enveloppe d'un client Supabase : une écriture nommée échoue N fois, le reste passe tel quel.
function withFaults<T>(client: T): T {
  // biome-ignore lint/suspicious/noExplicitAny: appels transmis tels quels au client réel.
  const target = client as any;
  const rpc = target.rpc.bind(target);
  target.rpc = (name: string, ...rest: unknown[]) => {
    harness.rpcCalls.push(name);
    const gate = harness.gate;
    if (
      gate &&
      !gate.used &&
      gate.rpc === name &&
      (rest[0] as { p_order_id?: string } | undefined)?.p_order_id === gate.orderId
    ) {
      gate.used = true;
      gate.entered();
      return gate.release.then(() => rpc(name, ...rest));
    }
    const left = harness.rpcFaults.get(name) ?? 0;
    if (left > 0) {
      harness.rpcFaults.set(name, left - 1);
      return Promise.resolve({ data: null, error: fault() });
    }
    return rpc(name, ...rest);
  };
  const from = target.from.bind(target);
  target.from = (table: string) => {
    const builder = from(table);
    if (table === 'orders' && harness.gate?.rpc === 'orders.update') {
      const update = builder.update.bind(builder);
      builder.update = (...args: unknown[]) => {
        const chain = update(...args);
        const gate = harness.gate;
        const patch = args[0] as { shopify_updated_at?: string } | undefined;
        if (
          gate &&
          !gate.used &&
          patch?.shopify_updated_at &&
          Date.parse(patch.shopify_updated_at) === gate.updatedAtMs
        ) {
          gate.used = true;
          gate.entered();
          const then = chain.then.bind(chain);
          // biome-ignore lint/suspicious/noThenProperty: le générateur de requête est un thenable ; on retient son exécution.
          chain.then = (resolve: unknown, reject: unknown) =>
            gate.release.then(() => then(resolve, reject));
        }
        return chain;
      };
    }
    if ((harness.insertFaults.get(table) ?? 0) > 0) {
      const insert = builder.insert.bind(builder);
      builder.insert = (...args: unknown[]) => {
        const left = harness.insertFaults.get(table) ?? 0;
        if (left > 0) {
          harness.insertFaults.set(table, left - 1);
          return Promise.resolve({ data: null, error: fault() });
        }
        return insert(...args);
      };
    }
    return builder;
  };
  return client;
}

vi.mock('next/server', () => ({
  after(callback: () => Promise<unknown>) {
    harness.callbacks.push(callback());
  },
}));

vi.mock('@/lib/supabase/protected-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/protected-client')>();
  return {
    ...actual,
    createProtectedSupabaseClient: (
      ...args: Parameters<typeof actual.createProtectedSupabaseClient>
    ) => withFaults(actual.createProtectedSupabaseClient(...args)),
  };
});

const APP_CLIENT_ID = 'replay-app';
const APP_SECRET = 'replay-secret';
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
type Replay = typeof import('@/lib/shopify/webhook-replay');
type EventRow = {
  attempt_count: number;
  id: string;
  last_error_code: string | null;
  payload: unknown;
  status: string;
};

const previousEnv = new Map<string, string | undefined>();
const createdUsers: string[] = [];
let admin: AdminClient;
let postWebhook: (request: Request) => Promise<Response>;
let replay: Replay;

const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const suite = serviceRoleKey ? describe : describe.skip;

function sign(body: string): string {
  return createHmac('sha256', APP_SECRET).update(body, 'utf8').digest('base64');
}

async function createFixture(status: 'active' | 'uninstalled' = 'active') {
  const suffix = randomUUID();
  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email: `replay-${suffix}@example.test`,
    email_confirm: true,
    password: `replay-${suffix}`,
  });
  if (userError || !userData.user) throw userError ?? new Error('utilisateur de test absent');
  createdUsers.push(userData.user.id);

  let merchantAccountId = '';
  for (let i = 0; i < 30 && !merchantAccountId; i++) {
    const account = await admin
      .from('merchant_account')
      .select('id')
      .eq('owner_user_id', userData.user.id)
      .maybeSingle();
    merchantAccountId = account.data?.id ?? '';
    if (!merchantAccountId) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!merchantAccountId) throw new Error('compte de test absent');

  const shopDomain = `replay-${suffix}.myshopify.com`;
  const shop = await admin
    .from('shop')
    .insert({
      access_token_encrypted: 'replay-local-token',
      merchant_account_id: merchantAccountId,
      scopes: 'read_orders,read_customers,read_products',
      shop_domain: shopDomain,
      shopify_client_id: APP_CLIENT_ID,
      status,
      uninstalled_at: status === 'uninstalled' ? new Date().toISOString() : null,
    })
    .select('id')
    .single();
  if (shop.error || !shop.data) throw shop.error ?? new Error('boutique de test absente');

  const customerExternalId = `replay-customer-${suffix}`;
  const customer = await admin
    .from('customer')
    .insert({
      full_name: 'Client Reprise',
      merchant_account_id: merchantAccountId,
      phone: '+221770000211',
      shop_id: shop.data.id,
      shopify_customer_id: customerExternalId,
    })
    .select('id')
    .single();
  if (customer.error || !customer.data) throw customer.error ?? new Error('client de test absent');

  const order = await admin
    .from('orders')
    .insert({
      call_state: 'to_call',
      cash_state: 'not_due',
      currency: 'XOF',
      customer_id: customer.data.id,
      delivery_state: 'unassigned',
      merchant_account_id: merchantAccountId,
      note: 'note-pii',
      order_number: `#REPLAY-${suffix}`,
      order_state: 'open',
      shop_id: shop.data.id,
      shopify_order_id: `replay-seed-${suffix}`,
      total_amount: 15000,
    })
    .select('id')
    .single();
  if (order.error || !order.data) throw order.error ?? new Error('commande de test absente');

  return {
    customerExternalId,
    customerId: customer.data.id,
    merchantAccountId,
    shopDomain,
    shopId: shop.data.id,
  };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

function request(f: Fixture, topic: string, payload: Record<string, unknown>, webhookId: string) {
  const body = JSON.stringify(payload);
  return new Request('http://localhost:3000/api/shopify/webhooks', {
    body,
    headers: new Headers({
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': sign(body),
      'x-shopify-shop-domain': f.shopDomain,
      'x-shopify-topic': topic,
      'x-shopify-triggered-at': new Date().toISOString(),
      'x-shopify-webhook-id': webhookId,
    }),
    method: 'POST',
  });
}

async function deliver(
  f: Fixture,
  topic: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; webhookId: string }> {
  const webhookId = `replay-${topic.replaceAll('/', '-')}-${randomUUID()}`;
  const response = await postWebhook(request(f, topic, payload, webhookId));
  await Promise.all(harness.callbacks.splice(0));
  return { status: response.status, webhookId };
}

const gdprPayload = (f: Fixture, topic: string) => ({
  shop_domain: f.shopDomain,
  ...(topic === 'shop/redact' ? {} : { customer: { id: f.customerExternalId } }),
});

function orderPayload(
  shopifyOrderId: string,
  updatedAt: string,
  extra: Record<string, unknown> = {},
) {
  return {
    created_at: '2026-10-07T10:00:00Z',
    currency: 'XOF',
    financial_status: 'pending',
    fulfillment_status: null,
    id: shopifyOrderId,
    line_items: [{ price: '5000', quantity: 2, title: 'Article de reprise' }],
    name: `#${shopifyOrderId}`,
    total_price: '10000',
    updated_at: updatedAt,
    ...extra,
  };
}

async function eventOf(webhookId: string): Promise<EventRow> {
  const { data, error } = await admin
    .from('webhook_event')
    .select('id, status, last_error_code, attempt_count, payload')
    .eq('shopify_webhook_id', webhookId)
    .single();
  if (error || !data) throw error ?? new Error(`événement absent : ${webhookId}`);
  return data;
}

/** Le temps passe : l'échéance de reprise est reculée au-delà de la marge d'horloge. */
async function makeDue(eventId: string): Promise<void> {
  const { error } = await admin
    .from('webhook_event')
    .update({ next_attempt_at: new Date(Date.now() - 10 * 60_000).toISOString() })
    .eq('id', eventId);
  if (error) throw error;
}

async function patchEvent(
  eventId: string,
  patch: Database['public']['Tables']['webhook_event']['Update'],
): Promise<void> {
  const { error } = await admin.from('webhook_event').update(patch).eq('id', eventId);
  if (error) throw error;
}

async function gdprTraces(f: Fixture, topic: string) {
  const artifacts = await admin
    .from('shopify_dsar_artifact')
    .select('status', { count: 'exact' })
    .eq('merchant_account_id', f.merchantAccountId)
    .eq('shop_id', f.shopId);
  const audits = await admin
    .from('audit_log')
    .select('id', { count: 'exact', head: true })
    .eq('merchant_account_id', f.merchantAccountId)
    .eq('action', `gdpr.${topic}`);
  const customer = await admin
    .from('customer')
    .select('full_name, phone')
    .eq('id', f.customerId)
    .maybeSingle();
  const tombstones = await admin
    .from('shopify_customer_redaction_tombstone')
    .select('id', { count: 'exact', head: true })
    .eq('merchant_account_id', f.merchantAccountId)
    .eq('shop_id', f.shopId);
  return {
    artifactStatuses: (artifacts.data ?? []).map((row) => row.status),
    artifacts: artifacts.count ?? 0,
    audits: audits.count ?? 0,
    customer: customer.data,
    tombstones: tombstones.count ?? 0,
  };
}

async function orderState(f: Fixture, shopifyOrderId: string) {
  const orders = await admin
    .from('orders')
    .select('id, shopify_updated_at, updated_at, shopify_financial_status')
    .eq('shop_id', f.shopId)
    .eq('shopify_order_id', shopifyOrderId);
  if (orders.error) throw orders.error;
  const order = orders.data?.[0] ?? null;
  const lines = order
    ? await admin
        .from('order_line')
        .select('id', { count: 'exact', head: true })
        .eq('order_id', order.id)
    : null;
  return { count: orders.data?.length ?? 0, lines: lines?.count ?? 0, order };
}

const sweep = () => replay.replayPendingShopifyWebhooks(withFaults(adminClient()));

function adminClient(): AdminClient {
  return createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '', serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Une demande d'accès livrée, répondue 200, dont le traitement a échoué sur le journal d'accès. */
async function failedDataRequest(f: Fixture) {
  harness.rpcFaults.set('log_pcd_access_event', 1);
  const delivery = await deliver(
    f,
    'customers/data_request',
    gdprPayload(f, 'customers/data_request'),
  );
  expect(delivery.status).toBe(200);
  const event = await eventOf(delivery.webhookId);
  expect(event.status).toBe('retryable');
  return { ...delivery, event };
}

suite('reprise interne des webhooks Shopify', () => {
  beforeAll(async () => {
    for (const key of SHOPIFY_ENV_KEYS) {
      previousEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    previousEnv.set('RESEND_API_KEY', process.env.RESEND_API_KEY);
    process.env.SHOPIFY_API_KEY = APP_CLIENT_ID;
    process.env.SHOPIFY_API_SECRET = APP_SECRET;
    process.env.RESEND_API_KEY = 'replay-local-resend-placeholder';
    assertLocalSupabase(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '');
    admin = adminClient();
    vi.resetModules();
    postWebhook = (await import('@/app/api/shopify/webhooks/route')).POST;
    replay = await import('@/lib/shopify/webhook-replay');
  }, 120_000);

  beforeEach(() => {
    harness.faultCode = '08006';
    harness.rpcFaults.clear();
    harness.insertFaults.clear();
    harness.gate = null;
    harness.rpcCalls.length = 0;
  });

  afterAll(async () => {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (!serviceRoleKey) return;
    await Promise.all(createdUsers.splice(0).map((id) => admin.auth.admin.deleteUser(id)));
  });

  it('demande d’accès : réponse 200, traitement en panne, aucune nouvelle livraison, reprise réussie', async () => {
    const f = await createFixture();
    const { event, webhookId } = await failedDataRequest(f);

    // L'erreur d'origine n'est plus jetée : son empreinte suit le code contrôlé.
    expect(event.last_error_code).toBe('shopify_pcd_audit_failed__08006');
    expect(event.payload).not.toBeNull();
    expect(await gdprTraces(f, 'customers/data_request')).toMatchObject({
      artifacts: 0,
      audits: 0,
    });

    // Pas encore due : la reprise la laisse en l'état.
    await sweep();
    expect((await eventOf(webhookId)).status).toBe('retryable');

    await makeDue(event.id);
    const summary = await sweep();

    expect(summary.replayed.done).toBeGreaterThanOrEqual(1);
    const after = await eventOf(webhookId);
    expect(after).toMatchObject({ attempt_count: 2, last_error_code: null, status: 'done' });
    expect(after.payload).toBeNull();
    expect(await gdprTraces(f, 'customers/data_request')).toMatchObject({
      artifactStatuses: ['ready'],
      artifacts: 1,
      audits: 1,
    });
  });

  it('une reprise rejouée n’écrit rien de plus', async () => {
    const f = await createFixture();
    const { event, webhookId } = await failedDataRequest(f);
    await makeDue(event.id);
    await sweep();
    const first = await gdprTraces(f, 'customers/data_request');

    await sweep();
    await sweep();

    expect(await eventOf(webhookId)).toMatchObject({ attempt_count: 2, status: 'done' });
    expect(await gdprTraces(f, 'customers/data_request')).toEqual(first);
  });

  it('deux reprises concurrentes : un seul traitement', async () => {
    const f = await createFixture();
    const { event, webhookId } = await failedDataRequest(f);
    await makeDue(event.id);

    await Promise.all([sweep(), sweep(), sweep()]);

    // Une seule réclamation a abouti : la tentative de la livraison, puis une reprise.
    expect(await eventOf(webhookId)).toMatchObject({ attempt_count: 2, status: 'done' });
    expect(await gdprTraces(f, 'customers/data_request')).toMatchObject({
      artifacts: 1,
      audits: 1,
    });
  });

  it('panne APRÈS la création de l’artefact : la reprise ne le double pas', async () => {
    const f = await createFixture();
    harness.insertFaults.set('audit_log', 1);
    const delivery = await deliver(
      f,
      'customers/data_request',
      gdprPayload(f, 'customers/data_request'),
    );
    const event = await eventOf(delivery.webhookId);
    expect(event).toMatchObject({
      last_error_code: 'gdpr_audit_failed__08006',
      status: 'retryable',
    });
    expect(await gdprTraces(f, 'customers/data_request')).toMatchObject({
      artifacts: 1,
      audits: 0,
    });

    await makeDue(event.id);
    await sweep();

    expect((await eventOf(delivery.webhookId)).status).toBe('done');
    expect(await gdprTraces(f, 'customers/data_request')).toMatchObject({
      artifactStatuses: ['ready'],
      artifacts: 1,
      audits: 1,
    });
  });

  it('suppression d’un client : panne, puis reprise ; les données sont effacées une fois', async () => {
    const f = await createFixture();
    harness.rpcFaults.set('redact_shopify_customer_copies', 1);
    const delivery = await deliver(f, 'customers/redact', gdprPayload(f, 'customers/redact'));
    const event = await eventOf(delivery.webhookId);
    expect(event).toMatchObject({
      last_error_code: 'gdpr_redaction_failed__08006',
      status: 'retryable',
    });
    expect((await gdprTraces(f, 'customers/redact')).customer).toMatchObject({
      full_name: 'Client Reprise',
    });

    await makeDue(event.id);
    await sweep();
    await sweep();

    expect((await eventOf(delivery.webhookId)).status).toBe('done');
    expect(await gdprTraces(f, 'customers/redact')).toMatchObject({
      audits: 1,
      customer: { full_name: '[client supprimé]', phone: null },
      tombstones: 1,
    });
  });

  it('suppression de boutique : reprise sur une boutique désinstallée, jamais seule sur une boutique active', async () => {
    const uninstalled = await createFixture('uninstalled');
    const active = await createFixture('active');
    const events: Record<string, { id: string; webhookId: string }> = {};
    for (const [label, f] of [
      ['uninstalled', uninstalled],
      ['active', active],
    ] as const) {
      harness.rpcFaults.set('redact_shopify_customer_copies', 1);
      const delivery = await deliver(f, 'shop/redact', gdprPayload(f, 'shop/redact'));
      const event = await eventOf(delivery.webhookId);
      expect(event.status).toBe('retryable');
      await makeDue(event.id);
      events[label] = { id: event.id, webhookId: delivery.webhookId };
    }

    const summary = await sweep();

    expect((await eventOf(events.uninstalled.webhookId)).status).toBe('done');
    expect((await gdprTraces(uninstalled, 'shop/redact')).customer).toMatchObject({
      full_name: '[client supprimé]',
    });

    // Boutique active : rien n'est effacé, l'événement attend une décision.
    expect(await eventOf(events.active.webhookId)).toMatchObject({
      attempt_count: 1,
      status: 'retryable',
    });
    expect((await gdprTraces(active, 'shop/redact')).customer).toMatchObject({
      full_name: 'Client Reprise',
    });
    expect(summary.skipped.shopRedactOnActiveShop).toBeGreaterThanOrEqual(1);
    expect(summary.needsReview['shop/redact']).toBeGreaterThanOrEqual(1);
  });

  it('bail, marge d’horloge, plafond, fenêtre : l’événement reste en l’état', async () => {
    const f = await createFixture();
    const untouched = async (label: string, patch: Parameters<typeof patchEvent>[1]) => {
      const { event, webhookId } = await failedDataRequest(f);
      await patchEvent(event.id, patch);
      const before = await eventOf(webhookId);
      await sweep();
      expect(await eventOf(webhookId), label).toEqual(before);
    };
    const past = (ms: number) => new Date(Date.now() - ms).toISOString();
    const future = (ms: number) => new Date(Date.now() + ms).toISOString();

    await untouched('en cours, bail non expiré', {
      lease_until: future(4 * 60_000),
      next_attempt_at: null,
      status: 'processing',
    });
    await untouched('en cours, bail expiré depuis moins que la marge', {
      lease_until: past(20_000),
      next_attempt_at: null,
      status: 'processing',
    });
    await untouched('échéance passée depuis moins que la marge', { next_attempt_at: past(20_000) });
    await untouched('tentatives épuisées', {
      attempt_count: 6,
      next_attempt_at: past(10 * 60_000),
    });
    await untouched('hors fenêtre', {
      next_attempt_at: past(10 * 60_000),
      received_at: past(8 * 24 * 60 * 60_000),
    });
    expect(await gdprTraces(f, 'customers/data_request')).toMatchObject({
      artifacts: 0,
      audits: 0,
    });
  });

  it('1 001 événements non éligibles plus récents ne masquent pas un événement éligible plus ancien', async () => {
    const f = await createFixture();
    const { event, webhookId } = await failedDataRequest(f);
    // Éligible, mais plus ancien que tout ce qui suit.
    await patchEvent(event.id, {
      next_attempt_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      received_at: new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString(),
    });

    // Plus d'événements non éligibles, et plus récents, que la limite de lecture (1 000) : ce que
    // l'ancienne lecture — les plus récents d'abord, filtrés en mémoire — ne dépassait jamais.
    const prefix = `replay-masque-${randomUUID()}`;
    const masks = Array.from({ length: 1_001 }, (_, index) => {
      const kind = index % 3;
      return {
        attempt_count: kind === 1 ? 6 : 1,
        last_error_code: 'shopify_order_persist_failed',
        merchant_account_id: f.merchantAccountId,
        next_attempt_at:
          kind === 0
            ? new Date(Date.now() + 60 * 60_000).toISOString()
            : new Date(Date.now() - 10 * 60_000).toISOString(),
        payload: { id: `${prefix}-${index}` },
        shop_domain: f.shopDomain,
        shop_id: f.shopId,
        shopify_webhook_id: `${prefix}-${index}`,
        status: 'retryable',
        // kind 2 : un sujet que la reprise ne prend pas.
        topic: kind === 2 ? 'products/update' : 'orders/updated',
      };
    });
    try {
      for (let from = 0; from < masks.length; from += 250) {
        const { error } = await admin.from('webhook_event').insert(masks.slice(from, from + 250));
        if (error) throw error;
      }

      const summary = await sweep();

      expect(await eventOf(webhookId)).toMatchObject({ attempt_count: 2, status: 'done' });
      expect(await gdprTraces(f, 'customers/data_request')).toMatchObject({
        artifacts: 1,
        audits: 1,
      });
      // Les non éligibles restent comptés pour un regard humain, jamais rejoués.
      expect(summary.skipped.exhausted + summary.skipped.unsupported_topic).toBeGreaterThan(0);
      const stillWaiting = await admin
        .from('webhook_event')
        .select('id', { count: 'exact', head: true })
        .like('shopify_webhook_id', `${prefix}-%`)
        .eq('status', 'retryable')
        .eq('attempt_count', 1);
      expect(stillWaiting.count).toBeGreaterThanOrEqual(667);
    } finally {
      await admin.from('webhook_event').delete().like('shopify_webhook_id', `${prefix}-%`);
    }
  }, 180_000);

  it('exécution morte en cours de traitement : reprise une fois le bail expiré au-delà de la marge', async () => {
    const f = await createFixture();
    const { event, webhookId } = await failedDataRequest(f);
    await patchEvent(event.id, {
      lease_until: new Date(Date.now() - 3 * 60_000).toISOString(),
      next_attempt_at: null,
      status: 'processing',
    });

    await sweep();

    expect(await eventOf(webhookId)).toMatchObject({ attempt_count: 2, status: 'done' });
    expect(await gdprTraces(f, 'customers/data_request')).toMatchObject({
      artifacts: 1,
      audits: 1,
    });
  });

  it('sujet non repris : app/uninstalled reste en l’état et est compté', async () => {
    const f = await createFixture();
    const webhookId = `replay-app-uninstalled-${randomUUID()}`;
    const inserted = await admin
      .from('webhook_event')
      .insert({
        attempt_count: 1,
        last_error_code: 'shopify_uninstall_ordered_failed',
        merchant_account_id: f.merchantAccountId,
        next_attempt_at: new Date(Date.now() - 10 * 60_000).toISOString(),
        payload: { shop_domain: f.shopDomain },
        shop_domain: f.shopDomain,
        shop_id: f.shopId,
        shopify_webhook_id: webhookId,
        status: 'retryable',
        topic: 'app/uninstalled',
      })
      .select('id')
      .single();
    if (inserted.error) throw inserted.error;
    const before = await eventOf(webhookId);

    const summary = await sweep();

    expect(await eventOf(webhookId)).toEqual(before);
    expect(summary.skipped.unsupported_topic).toBeGreaterThanOrEqual(1);
    expect(summary.needsReview['app/uninstalled']).toBeGreaterThanOrEqual(1);
    const shop = await admin.from('shop').select('status').eq('id', f.shopId).single();
    expect(shop.data?.status).toBe('active');
  });

  it('commande : création en panne, réponse 200, aucune nouvelle livraison, reprise avec ses lignes', async () => {
    const f = await createFixture();
    const shopifyOrderId = `${Date.now()}1`;
    harness.rpcFaults.set('create_shopify_order_with_lines', 1);
    const delivery = await deliver(
      f,
      'orders/create',
      orderPayload(shopifyOrderId, '2026-10-07T10:00:00Z'),
    );
    expect(delivery.status).toBe(200);
    const event = await eventOf(delivery.webhookId);
    expect(event).toMatchObject({
      last_error_code: 'shopify_order_persist_failed__08006',
      status: 'retryable',
    });
    expect((await orderState(f, shopifyOrderId)).count).toBe(0);

    await makeDue(event.id);
    await sweep();

    expect((await eventOf(delivery.webhookId)).status).toBe('done');
    expect(await orderState(f, shopifyOrderId)).toMatchObject({ count: 1, lines: 1 });
  });

  it('orders/create et orders/updated ensemble sur une commande neuve : deux succès, une commande', async () => {
    const f = await createFixture();
    for (let n = 0; n < 6; n++) {
      const shopifyOrderId = `${Date.now()}${n}2`;
      const withCustomer = n % 2 === 0;
      const customer = withCustomer
        ? { customer: { first_name: 'Awa', id: `${shopifyOrderId}9`, last_name: `N${n}` } }
        : {};
      const ids = [`replay-create-${randomUUID()}`, `replay-updated-${randomUUID()}`] as const;
      const responses = await Promise.all([
        postWebhook(
          request(
            f,
            'orders/create',
            orderPayload(shopifyOrderId, '2026-10-07T10:00:00Z', customer),
            ids[0],
          ),
        ),
        postWebhook(
          request(
            f,
            'orders/updated',
            orderPayload(shopifyOrderId, '2026-10-07T10:00:02Z', {
              ...customer,
              financial_status: 'paid',
            }),
            ids[1],
          ),
        ),
      ]);
      await Promise.all(harness.callbacks.splice(0));

      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      // Ni l'une ni l'autre n'est classée en échec : la collision est un succès idempotent.
      expect(await eventOf(ids[0]), `paire ${n}, create`).toMatchObject({
        last_error_code: null,
        status: 'done',
      });
      expect(await eventOf(ids[1]), `paire ${n}, updated`).toMatchObject({
        last_error_code: null,
        status: 'done',
      });
      const state = await orderState(f, shopifyOrderId);
      expect(state, `paire ${n}`).toMatchObject({ count: 1, lines: 1 });
      // La mise à jour est appliquée, quelle que soit la livraison arrivée la première.
      expect(Date.parse(state.order?.shopify_updated_at ?? '')).toBe(
        Date.parse('2026-10-07T10:00:02Z'),
      );
      expect(state.order?.shopify_financial_status).toBe('paid');
    }
  });

  it('deux collisions de suite sont relues ; la troisième est un échec, avec son origine', async () => {
    const f = await createFixture();
    harness.faultCode = '23505';

    // Client puis commande : la même course peut buter deux fois avant d'aboutir.
    const twice = `${Date.now()}4`;
    harness.rpcFaults.set('create_shopify_order_with_lines', 2);
    const recovered = await deliver(
      f,
      'orders/create',
      orderPayload(twice, '2026-10-07T10:00:00Z'),
    );
    expect(await eventOf(recovered.webhookId)).toMatchObject({
      last_error_code: null,
      status: 'done',
    });
    expect(await orderState(f, twice)).toMatchObject({ count: 1, lines: 1 });

    // Au-delà, ce n'est plus une course : l'échec est rendu, borné, et nommé.
    const thrice = `${Date.now()}5`;
    harness.rpcFaults.set('create_shopify_order_with_lines', 3);
    const failed = await deliver(f, 'orders/create', orderPayload(thrice, '2026-10-07T10:00:00Z'));
    expect(await eventOf(failed.webhookId)).toMatchObject({
      last_error_code: 'shopify_order_persist_failed__23505',
      status: 'retryable',
    });
    expect(harness.rpcFaults.get('create_shopify_order_with_lines')).toBe(0);
    expect((await orderState(f, thrice)).count).toBe(0);
  });

  it('charge de commande déjà appliquée : la reprise l’écarte sans écriture ; plus récente : elle l’applique', async () => {
    const f = await createFixture();
    const shopifyOrderId = `${Date.now()}3`;
    await deliver(f, 'orders/create', orderPayload(shopifyOrderId, '2026-10-07T10:00:05Z'));
    const applied = await orderState(f, shopifyOrderId);
    expect(applied).toMatchObject({ count: 1, lines: 1 });

    const pending = async (updatedAt: string, extra: Record<string, unknown> = {}) => {
      const webhookId = `replay-orders-updated-${randomUUID()}`;
      const inserted = await admin
        .from('webhook_event')
        .insert({
          attempt_count: 1,
          last_error_code: 'shopify_order_persist_failed',
          merchant_account_id: f.merchantAccountId,
          next_attempt_at: new Date(Date.now() - 10 * 60_000).toISOString(),
          payload: orderPayload(shopifyOrderId, updatedAt, extra),
          shop_domain: f.shopDomain,
          shop_id: f.shopId,
          shopify_webhook_id: webhookId,
          status: 'retryable',
          topic: 'orders/updated',
        })
        .select('id')
        .single();
      if (inserted.error) throw inserted.error;
      return webhookId;
    };

    const same = await pending('2026-10-07T10:00:05Z', { financial_status: 'paid' });
    const older = await pending('2026-10-07T10:00:01Z', { financial_status: 'refunded' });
    await sweep();

    expect((await eventOf(same)).status).toBe('done');
    expect((await eventOf(older)).status).toBe('done');
    // Aucune écriture sur la commande : ni son contenu, ni sa date de modification.
    expect((await orderState(f, shopifyOrderId)).order).toEqual(applied.order);

    const newer = await pending('2026-10-07T10:00:09Z', { financial_status: 'paid' });
    await sweep();

    expect((await eventOf(newer)).status).toBe('done');
    const after = await orderState(f, shopifyOrderId);
    expect(after).toMatchObject({ count: 1, lines: 1 });
    expect(Date.parse(after.order?.shopify_updated_at ?? '')).toBe(
      Date.parse('2026-10-07T10:00:09Z'),
    );
    expect(after.order?.shopify_financial_status).toBe('paid');
  });

  it.each(['resync', 'update'] as const)(
    'reprise ancienne concurrente d’une livraison plus récente (%s) : la charge la plus récente n’est jamais écrasée',
    async (path) => {
      const f = await createFixture();
      const shopifyOrderId = `${Date.now()}${path === 'resync' ? 4 : 5}`;
      await deliver(f, 'orders/create', orderPayload(shopifyOrderId, '2026-10-07T10:00:05Z'));
      const created = await orderState(f, shopifyOrderId);
      expect(created).toMatchObject({ count: 1, lines: 1 });
      const orderId = created.order?.id ?? '';
      if (path === 'update') {
        // Panier modifié dans Tëër : l'import n'en reconstruit pas les lignes, et écrit l'en-tête
        // par une écriture directe — l'autre chemin d'écriture.
        const modified = await admin
          .from('orders')
          .update({ cart_locally_modified_at: new Date().toISOString() })
          .eq('id', orderId);
        if (modified.error) throw modified.error;
      }

      // Une reprise EN ATTENTE : une mise à jour plus récente que la base (10:00:09), restée
      // retryable. Elle est valide à la lecture : elle l'est moins quand elle écrit.
      const oldWebhookId = `replay-orders-updated-${randomUUID()}`;
      const oldEvent = await admin
        .from('webhook_event')
        .insert({
          attempt_count: 1,
          last_error_code: 'shopify_order_persist_failed',
          merchant_account_id: f.merchantAccountId,
          next_attempt_at: new Date(Date.now() - 10 * 60_000).toISOString(),
          payload: orderPayload(shopifyOrderId, '2026-10-07T10:00:09Z', {
            financial_status: 'pending',
            total_price: '11000',
          }),
          shop_domain: f.shopDomain,
          shop_id: f.shopId,
          shopify_webhook_id: oldWebhookId,
          status: 'retryable',
          topic: 'orders/updated',
        })
        .select('id')
        .single();
      if (oldEvent.error) throw oldEvent.error;

      // La reprise lit la commande (10:00:05), décide « plus récent », puis est retenue AVANT d'écrire.
      let reached: () => void = () => undefined;
      const entered = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let release: () => void = () => undefined;
      harness.gate = {
        entered: reached,
        orderId,
        release: new Promise<void>((resolve) => {
          release = resolve;
        }),
        rpc: path === 'resync' ? 'resync_shopify_order_cart' : 'orders.update',
        updatedAtMs: Date.parse('2026-10-07T10:00:09Z'),
        used: false,
      };
      const replaying = sweep();
      await entered;

      // Pendant ce temps, une livraison PLUS RÉCENTE (10:00:20) de la même commande est traitée.
      const fresh = await deliver(
        f,
        'orders/updated',
        orderPayload(shopifyOrderId, '2026-10-07T10:00:20Z', {
          financial_status: 'paid',
          total_price: '12000',
        }),
      );
      expect(fresh.status).toBe(200);
      expect((await eventOf(fresh.webhookId)).status).toBe('done');

      release();
      await replaying;

      expect((await eventOf(oldWebhookId)).status).toBe('done');
      const after = await orderState(f, shopifyOrderId);
      expect(after.count).toBe(1);
      expect(Date.parse(after.order?.shopify_updated_at ?? '')).toBe(
        Date.parse('2026-10-07T10:00:20Z'),
      );
      expect(after.order?.shopify_financial_status).toBe('paid');
      const amount = await admin.from('orders').select('total_amount').eq('id', orderId).single();
      // Panier modifié dans Tëër : le montant local est conservé, seule la charge importe.
      expect(Number(amount.data?.total_amount)).toBe(path === 'resync' ? 12000 : 10000);
    },
    60_000,
  );
});
