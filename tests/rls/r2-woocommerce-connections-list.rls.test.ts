/**
 * R2.4 — `listWooCommerceConnectionsAction` exécutée jusqu'à son retour final contre le VRAI
 * PostgREST local et le schéma 0154.
 *
 * Pourquoi ce fichier existe : `tests/unit/woocommerce-connections-action.test.ts` remplace le
 * constructeur de requêtes par un faux dont `order: () => result` renvoie un succès quel que soit
 * le nom de colonne. Il ne pouvait donc pas voir que `store_connection` n'a pas de colonne
 * `updated_at` — PostgREST répondait 400/42703 pour TOUS les comptes, l'action renvoyait
 * `list_failed`, et l'écran rendait cette erreur comme « Aucune boutique WooCommerce connectée ».
 *
 * Ce qui est RÉEL ici : le constructeur `@supabase/supabase-js`, le client service-role protégé
 * (`createProtectedSupabaseClient`, contrôle de cible inclus), le transport HTTP PostgREST et le
 * catalogue réel de la base locale. Chaque colonne, chaque filtre, chaque tri et chaque `.in(...)`
 * de l'action est donc évalué par PostgreSQL.
 *
 * Ce qui est SUBSTITUÉ, et pourquoi : `@/lib/env` (le stack local ne porte pas `RESEND_API_KEY`,
 * et une suite non chargeable ne prouve rien) et `requireRole` (la garde de rôle est testée
 * ailleurs ; l'action lit avec un client service-role, aucune RLS n'intervient dans ce chemin).
 * Aucune valeur de retour de la base n'est simulée.
 */

import { randomUUID } from 'node:crypto';
import type {
  WooCommerceConnectionListItem,
  WooCommerceShopOption,
} from '@/lib/actions/woocommerce';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    NEXT_PUBLIC_APP_URL: 'https://teer.example',
  },
}));

vi.mock('@/lib/actions/safe-action', () => ({
  requireRole: () => {
    const builder = {
      metadata: () => builder,
      inputSchema: () => builder,
      action: (handler: unknown) => handler,
    };
    return builder;
  },
}));

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const password = 'r2-woocommerce-list-password';

type Client = SupabaseClient<Database>;
type Tenant = { accountId: string; memberId: string; userId: string };
type ListSuccess = {
  ok: true;
  shops: WooCommerceShopOption[];
  canCreateNewShop: boolean;
  connections: WooCommerceConnectionListItem[];
};
type ListResult = ListSuccess | { ok: false; errorCode: string };
type ListHandler = (input: {
  ctx: { member: { id: string; merchantAccountId: string; role: string } };
}) => Promise<ListResult>;

const createdUserIds: string[] = [];
let admin: Client;
let listConnections: ListHandler;

function serviceClient(): Client {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createTenant(label: string): Promise<Tenant> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `r2-woo-list-${label}-${Date.now()}-${randomUUID()}@example.com`,
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

  const { data: member, error: memberError } = await admin
    .from('merchant_member')
    .select('id')
    .eq('merchant_account_id', account.id)
    .eq('user_id', data.user.id)
    .single();
  expect(memberError).toBeNull();
  if (!member) throw new Error('merchant member missing');

  return { accountId: account.id, memberId: member.id, userId: data.user.id };
}

async function createWooShop(tenant: Tenant, displayName: string): Promise<WooCommerceShopOption> {
  const domain = `woo-list-${randomUUID().replaceAll('-', '')}.example`;
  const { data, error } = await admin
    .from('shop')
    .insert({
      merchant_account_id: tenant.accountId,
      shop_domain: domain,
      display_name: displayName,
      store_kind: 'woocommerce',
      status: 'active',
      scopes: '',
      is_default: false,
    })
    .select('id')
    .single();
  expect(error).toBeNull();
  if (!data) throw new Error('woocommerce shop missing');
  return { id: data.id, displayName, domain };
}

async function createConnection(
  tenant: Tenant,
  shopId: string,
  status: string,
  createdAt: string,
): Promise<{ id: string; externalIdentifier: string }> {
  const externalIdentifier = `https://${randomUUID()}.example/`;
  const { data, error } = await admin
    .from('store_connection')
    .insert({
      merchant_account_id: tenant.accountId,
      shop_id: shopId,
      platform: 'woocommerce',
      external_identifier: externalIdentifier,
      status,
      created_at: createdAt,
    })
    .select('id')
    .single();
  expect(error).toBeNull();
  if (!data) throw new Error('store connection missing');
  return { id: data.id, externalIdentifier };
}

async function createSubscription(
  tenant: Tenant,
  shopId: string,
  connectionId: string,
  topic: 'order.created' | 'order.updated',
  status: string,
): Promise<void> {
  const { error } = await admin.from('store_connection_webhook_subscription').insert({
    store_connection_id: connectionId,
    merchant_account_id: tenant.accountId,
    shop_id: shopId,
    topic,
    delivery_token_hash: randomUUID().replaceAll('-', '').repeat(2),
    secret_encrypted: 'fixture-secret',
    status,
  });
  expect(error).toBeNull();
}

async function createSyncState(
  tenant: Tenant,
  shopId: string,
  connectionId: string,
  state: { status: string; lastErrorCode: string | null; lastPageObserved: number },
): Promise<void> {
  const { error } = await admin.from('store_connection_sync_state').insert({
    store_connection_id: connectionId,
    merchant_account_id: tenant.accountId,
    shop_id: shopId,
    window_start: '2026-06-01T00:00:00.000Z',
    window_end: '2026-09-01T00:00:00.000Z',
    status: state.status,
    last_error_code: state.lastErrorCode,
    last_page_observed: state.lastPageObserved,
  });
  expect(error).toBeNull();
}

function expectSuccess(result: ListResult): ListSuccess {
  if (!result.ok) throw new Error(`action refusée : ${result.errorCode}`);
  return result;
}

beforeAll(async () => {
  if (!serviceRoleKey) return;
  admin = serviceClient();
  const actions = await import('@/lib/actions/woocommerce');
  listConnections = actions.listWooCommerceConnectionsAction as unknown as ListHandler;
});

afterAll(async () => {
  if (!serviceRoleKey) return;
  for (const userId of createdUserIds) await admin.auth.admin.deleteUser(userId);
});

describe.skipIf(!serviceRoleKey)('R2.4 — lecture réelle des connexions WooCommerce', () => {
  it('renvoie un succès vide ouvrant la première connexion, pas une erreur', async () => {
    const tenant = await createTenant('empty');

    // Un autre locataire porte une vraie connexion WooCommerce au même instant : le vide mesuré
    // ci-dessous prouve le filtre de compte, jamais une table vide.
    const other = await createTenant('neighbour');
    const otherShop = await createWooShop(other, 'Boutique du voisin');
    await createConnection(other, otherShop.id, 'active', new Date().toISOString());

    const result = expectSuccess(
      await listConnections({
        ctx: {
          member: { id: tenant.memberId, merchantAccountId: tenant.accountId, role: 'owner' },
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.canCreateNewShop).toBe(true);
    expect(result.shops).toEqual([]);
    expect(result.connections).toEqual([]);
  });

  it('renvoie boutiques, connexions, abonnements et synchronisation dans l’ordre attendu', async () => {
    const tenant = await createTenant('populated');
    const shopA = await createWooShop(tenant, 'Boutique Woo A');
    const shopB = await createWooShop(tenant, 'Boutique Woo B');

    const older = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const newer = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const connectionA = await createConnection(tenant, shopA.id, 'provisioning', older);
    const connectionB = await createConnection(tenant, shopB.id, 'active', newer);

    await createSubscription(tenant, shopA.id, connectionA.id, 'order.created', 'provisioning');
    await createSubscription(tenant, shopB.id, connectionB.id, 'order.created', 'active');
    await createSubscription(tenant, shopB.id, connectionB.id, 'order.updated', 'active');
    await createSyncState(tenant, shopA.id, connectionA.id, {
      status: 'failed',
      lastErrorCode: 'sync_total_changed',
      lastPageObserved: 2,
    });
    await createSyncState(tenant, shopB.id, connectionB.id, {
      status: 'completed',
      lastErrorCode: null,
      lastPageObserved: 4,
    });

    const result = expectSuccess(
      await listConnections({
        ctx: {
          member: { id: tenant.memberId, merchantAccountId: tenant.accountId, role: 'owner' },
        },
      }),
    );

    // Requête A : filtre `store_kind`, tri `display_name` ascendant.
    expect(result.shops).toEqual([
      { id: shopA.id, displayName: 'Boutique Woo A', domain: shopA.domain },
      { id: shopB.id, displayName: 'Boutique Woo B', domain: shopB.domain },
    ]);

    // Requête B : une connexion existe, donc plus aucun parcours « nouvelle boutique ».
    expect(result.canCreateNewShop).toBe(false);

    // Requête B : tri décroissant réellement appliqué par PostgreSQL (B créée après A).
    expect(result.connections.map((connection) => connection.id)).toEqual([
      connectionB.id,
      connectionA.id,
    ]);

    // Requêtes C et D : branches `.in(...)` réellement exécutées, valeurs vérifiées une à une.
    expect(result.connections[0]).toEqual({
      id: connectionB.id,
      shopId: shopB.id,
      shopName: 'Boutique Woo B',
      shopDomain: shopB.domain,
      externalIdentifier: connectionB.externalIdentifier,
      status: 'active',
      subscriptions: { 'order.created': 'active', 'order.updated': 'active' },
      syncStatus: 'completed',
      syncLastErrorCode: null,
      syncLastPageObserved: 4,
      syncUpdatedAt: expect.any(String),
    });
    expect(result.connections[1]).toEqual({
      id: connectionA.id,
      shopId: shopA.id,
      shopName: 'Boutique Woo A',
      shopDomain: shopA.domain,
      externalIdentifier: connectionA.externalIdentifier,
      status: 'provisioning',
      subscriptions: { 'order.created': 'provisioning' },
      syncStatus: 'failed',
      syncLastErrorCode: 'sync_total_changed',
      syncLastPageObserved: 2,
      syncUpdatedAt: expect.any(String),
    });
  });
});
