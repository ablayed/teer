/**
 * D2 — course de réclamation du bail de synchronisation WooCommerce.
 *
 * Cette suite mesure la comparaison-et-échange sur `attempt` contre un VRAI PostgREST. Un faux
 * ne prouverait pas la réévaluation du prédicat par PostgreSQL sur la ligne verrouillée : il
 * mesurerait le faux. Le test appelle `claimSyncState` — le chemin réel — et ne reproduit jamais
 * son `UPDATE` à la main : reproduire la requête prouverait le moteur, appeler la fonction prouve
 * que le code construit le bon prédicat.
 */

import { randomUUID } from 'node:crypto';
import { resolveWooCommerceConnectionById } from '@/lib/ingestion/resolve-connection';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const password = 'd2-woocommerce-sync-lease-password';

// Doit rester égal à SYNC_LEASE_MS dans lib/woocommerce/sync.ts.
const LEASE_MS = 150 * 1000;

type Client = SupabaseClient<Database>;
type Tenant = { accountId: string; userId: string };

const createdUserIds: string[] = [];
let admin: Client;
let claimSyncState: typeof import('@/lib/woocommerce/sync').claimSyncState;

function serviceClient(): Client {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createTenant(label: string): Promise<Tenant> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `d2-sync-lease-${label}-${Date.now()}-${randomUUID()}@example.com`,
    password,
    email_confirm: true,
  });
  expect(error).toBeNull();
  if (!data.user) throw new Error('synthetic user missing');
  createdUserIds.push(data.user.id);

  const { data: account, error: accountError } = await admin
    .from('merchant_account')
    .select('id')
    .eq('owner_user_id', data.user.id)
    .single();
  expect(accountError).toBeNull();
  if (!account) throw new Error('synthetic account missing');

  return { accountId: account.id, userId: data.user.id };
}

async function createWooShop(tenant: Tenant): Promise<string> {
  const { data, error } = await admin
    .from('shop')
    .insert({
      merchant_account_id: tenant.accountId,
      shop_domain: `woo-lease-${randomUUID().replaceAll('-', '')}.internal`,
      display_name: 'Boutique WooCommerce de test',
      store_kind: 'woocommerce',
      status: 'active',
      scopes: '',
      is_default: false,
    })
    .select('id')
    .single();
  expect(error).toBeNull();
  if (!data) throw new Error('woocommerce shop missing');
  return data.id;
}

async function createActiveConnection(tenant: Tenant, shopId: string): Promise<string> {
  const { data, error } = await admin
    .from('store_connection')
    .insert({
      merchant_account_id: tenant.accountId,
      shop_id: shopId,
      platform: 'woocommerce',
      external_identifier: `https://${randomUUID()}.example/`,
      status: 'active',
    })
    .select('id')
    .single();
  expect(error).toBeNull();
  if (!data) throw new Error('store connection missing');
  return data.id;
}

async function seedRunningState(
  tenant: Tenant,
  shopId: string,
  connectionId: string,
  updatedAt: string,
  attempt: number,
): Promise<void> {
  const { error } = await admin.from('store_connection_sync_state').insert({
    store_connection_id: connectionId,
    merchant_account_id: tenant.accountId,
    shop_id: shopId,
    window_start: '2026-06-13T12:34:56.000Z',
    window_end: '2026-09-11T12:34:56.000Z',
    status: 'running',
    attempt,
    last_page_observed: 4,
    updated_at: updatedAt,
  });
  expect(error).toBeNull();
}

async function readState(connectionId: string) {
  const { data, error } = await admin
    .from('store_connection_sync_state')
    .select('status, attempt, last_page_observed, updated_at')
    .eq('store_connection_id', connectionId)
    .single();
  expect(error).toBeNull();
  if (!data) throw new Error('sync state missing');
  return data;
}

async function createCredential(
  tenant: Tenant,
  shopId: string,
  connectionId: string,
): Promise<void> {
  const { error } = await admin.from('store_connection_credential').insert({
    store_connection_id: connectionId,
    merchant_account_id: tenant.accountId,
    shop_id: shopId,
    scheme: 'basic_consumer',
    key_id: 'fixture-key',
    consumer_key_encrypted: 'fixture-consumer-key',
    consumer_secret_encrypted: 'fixture-consumer-secret',
    key_permissions: 'read_write',
  });
  expect(error).toBeNull();
}

/** Connexion complète, sans état de synchronisation : le premier scan crée la ligne. */
async function createRunnableConnection(
  label: string,
): Promise<{ tenant: Tenant; shopId: string; connectionId: string }> {
  const tenant = await createTenant(label);
  const shopId = await createWooShop(tenant);
  const connectionId = await createActiveConnection(tenant, shopId);
  await createCredential(tenant, shopId, connectionId);
  return { tenant, shopId, connectionId };
}

async function bumpAttempt(connectionId: string): Promise<void> {
  const state = await readState(connectionId);
  const { error } = await admin
    .from('store_connection_sync_state')
    .update({ attempt: state.attempt + 1 })
    .eq('store_connection_id', connectionId);
  expect(error).toBeNull();
}

/** Client WooCommerce injecté : aucune page, donc le scan va droit à sa clôture. */
function emptyPageClient(beforeResponse?: () => Promise<void>) {
  return {
    readJsonWithHeaders: async () => {
      if (beforeResponse) await beforeResponse();
      return {
        data: [],
        headers: { 'x-wp-total': '0', 'x-wp-totalpages': '0' },
      };
    },
  };
}

async function synchronize(connectionId: string, client: ReturnType<typeof emptyPageClient>) {
  const { synchronizeWooCommerceOrders } = await import('@/lib/woocommerce/sync');
  return synchronizeWooCommerceOrders(connectionId, {
    admin,
    client: client as never,
  });
}

/** Le contexte résolu ne peut venir que de resolve-connection : jamais construit littéralement. */
async function resolveConnection(connectionId: string) {
  const resolved = await resolveWooCommerceConnectionById(admin, connectionId);
  if (!resolved.ok) throw new Error(`connexion non résolue : ${resolved.reason}`);
  return resolved.connection;
}

beforeAll(async () => {
  if (!serviceRoleKey) return;
  admin = serviceClient();
  claimSyncState = (await import('@/lib/woocommerce/sync')).claimSyncState;
});

afterAll(async () => {
  if (serviceRoleKey) {
    for (const userId of createdUserIds) await admin.auth.admin.deleteUser(userId);
  }
});

describe.skipIf(!serviceRoleKey)('D2 — bail de synchronisation WooCommerce', () => {
  it('deux réclamations concurrentes : exactement une gagne', async () => {
    const tenant = await createTenant('race');
    const shopId = await createWooShop(tenant);
    const connectionId = await createActiveConnection(tenant, shopId);
    const now = new Date();
    await seedRunningState(
      tenant,
      shopId,
      connectionId,
      new Date(now.getTime() - LEASE_MS - 5_000).toISOString(),
      7,
    );

    const connection = await resolveConnection(connectionId);
    const outcomes = await Promise.all([
      claimSyncState(admin, connection, now),
      claimSyncState(admin, connection, now),
    ]);

    const claimed = outcomes.filter((outcome) => outcome.kind === 'claimed');
    expect(claimed).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind !== 'claimed')).toHaveLength(1);

    // La preuve numérique : la génération n'a avancé que d'un cran, jamais de deux.
    const state = await readState(connectionId);
    expect(state.attempt).toBe(8);
    expect(state.status).toBe('running');
    expect(state.last_page_observed).toBe(0);
  });

  it('refuse une réclamation dont le bail court encore, sans toucher la ligne', async () => {
    const tenant = await createTenant('fresh');
    const shopId = await createWooShop(tenant);
    const connectionId = await createActiveConnection(tenant, shopId);
    const now = new Date();
    const updatedAt = new Date(now.getTime() - 5_000).toISOString();
    await seedRunningState(tenant, shopId, connectionId, updatedAt, 7);

    const connection = await resolveConnection(connectionId);
    const outcome = await claimSyncState(admin, connection, now);

    expect(outcome.kind).toBe('running');
    const state = await readState(connectionId);
    expect(state.attempt).toBe(7);
    expect(state.last_page_observed).toBe(4);
    expect(Date.parse(state.updated_at)).toBe(Date.parse(updatedAt));
  });

  it('reprend un bail expiré et remet la position de lecture à zéro', async () => {
    const tenant = await createTenant('expired');
    const shopId = await createWooShop(tenant);
    const connectionId = await createActiveConnection(tenant, shopId);
    const now = new Date();
    await seedRunningState(
      tenant,
      shopId,
      connectionId,
      new Date(now.getTime() - LEASE_MS - 5_000).toISOString(),
      7,
    );

    const connection = await resolveConnection(connectionId);
    const outcome = await claimSyncState(admin, connection, now);

    expect(outcome.kind).toBe('claimed');
    if (outcome.kind !== 'claimed') throw new Error('réclamation attendue');
    expect(outcome.state.attempt).toBe(8);
    expect(Date.parse(outcome.state.window_start)).toBe(Date.parse('2026-06-13T12:34:56.000Z'));
    const state = await readState(connectionId);
    expect(state.attempt).toBe(8);
    expect(state.last_page_observed).toBe(0);
  });
  it('cloture reellement quand le bail est intact', async () => {
    const fixture = await createRunnableConnection('write-ok');
    const result = await synchronize(fixture.connectionId, emptyPageClient());

    expect(result).toEqual({ ok: true, status: 'completed' });
    const state = await readState(fixture.connectionId);
    expect(state.status).toBe('completed');
    expect(state.attempt).toBe(1);
  });

  it('refuse la cloture quand le bail a ete repris pendant le scan', async () => {
    const fixture = await createRunnableConnection('write-stolen');
    // Le vol survient entre la reclamation et la cloture : la lecture de page le declenche.
    const result = await synchronize(
      fixture.connectionId,
      emptyPageClient(async () => {
        await bumpAttempt(fixture.connectionId);
      }),
    );

    expect(result).toEqual({ ok: false, errorCode: 'sync_lease_lost' });
    const state = await readState(fixture.connectionId);
    // Le statut n est ni `completed` ni `failed` : l ancien worker n a rien ecrit.
    expect(state.status).toBe('running');
    expect(state.attempt).toBe(2);
  });
});
