/**
 * Lot L3 (périmètre réduit) — `store_connection_webhook_token` (migration 0143).
 *
 * Preuve n°5 du lot : la surface portant les matériaux du jeton est PROUVÉE
 * illisible, pas seulement conçue comme telle. Deux angles :
 *   1. ACL de table réelle (`has_table_privilege`) — anon : rien, authenticated :
 *      rien non plus (contrairement à store_connection/external_ref/ingestion_event,
 *      qui ont un SELECT authenticated légitime) ; service_role : tout.
 *   2. Un VRAI `select` PostgREST sous un JWT anon et sous un JWT authenticated
 *      (membre réel du tenant propriétaire de la connexion) ne rend rien —
 *      ni ligne, ni fragment de secret_hash.
 *
 * `store_connection_webhook_token` est confirmée en production (`supabase
 * migration list --linked`, Local=Remote=0143) et typée dans
 * `database.types.ts` depuis la régénération qui a suivi — un seul client
 * Supabase typé est utilisé partout dans ce fichier.
 */

import { randomUUID } from 'node:crypto';
import { hashWebhookTokenSecret } from '@/lib/ingestion/webhook-token';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterAll, describe, expect, it } from 'vitest';
import { type TestPostgresClient, createTestPostgresClient } from '../helpers/postgres-client';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const dbUrl =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const password = 'l3-webhook-token-secrecy-pw-0143';
const createdUserIds: string[] = [];

type Client = SupabaseClient<Database>;

function adminClient(): Client {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createConfirmedUser(admin: Client, email: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('user creation failed');
  createdUserIds.push(data.user.id);
  return data.user.id;
}

async function waitForMerchantAccount(admin: Client, userId: string) {
  for (let i = 0; i < 20; i++) {
    const { data } = await admin
      .from('merchant_account')
      .select('id')
      .eq('owner_user_id', userId)
      .limit(1)
      .maybeSingle();
    if (data?.id) return data.id;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('merchant_account not found');
}

async function defaultShopId(admin: Client, merchantAccountId: string) {
  const { data, error } = await admin
    .from('shop')
    .select('id')
    .eq('merchant_account_id', merchantAccountId)
    .eq('is_default', true)
    .single();
  if (error || !data) throw error ?? new Error('default shop not found');
  return data.id;
}

async function createShopifyShop(admin: Client, merchantAccountId: string) {
  const { data, error } = await admin
    .from('shop')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_domain: `l3-token-secrecy-${Date.now()}-${randomUUID()}.myshopify.com`,
      access_token_encrypted: 'enc',
      scopes: 'read_orders',
      store_kind: 'shopify',
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('shopify shop insert failed');
  return data.id;
}

async function signIn(email: string): Promise<Client> {
  const client = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

async function setUpFixture() {
  const admin = adminClient();
  const email = `l3-token-secrecy-owner-${Date.now()}-${randomUUID()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  const defaultShop = await defaultShopId(admin, merchantAccountId);
  const shopId = await createShopifyShop(admin, merchantAccountId);

  const { data: connection, error: connectionError } = await admin
    .from('store_connection')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      platform: 'shopify',
      external_identifier: `l3-token-secrecy-${Date.now()}-${randomUUID()}.myshopify.com`,
      platform_app_id: 'app-a',
    })
    .select('id')
    .single();
  if (connectionError || !connection)
    throw connectionError ?? new Error('connection insert failed');

  const secret = randomUUID();
  const secretHash = hashWebhookTokenSecret(secret);
  const publicId = randomUUID();

  const { error: tokenError } = await admin.from('store_connection_webhook_token').insert({
    store_connection_id: connection.id,
    public_id: publicId,
    secret_hash: secretHash,
  });
  if (tokenError) throw tokenError;

  return { email, userId, merchantAccountId, defaultShop, connectionId: connection.id, secretHash };
}

let pg: TestPostgresClient | undefined;
async function pgClient(): Promise<TestPostgresClient> {
  if (pg) return pg;
  pg = createTestPostgresClient(dbUrl, 'SUPABASE_DB_URL', { connectionTimeoutMillis: 10_000 });
  await pg.connect();
  return pg;
}

afterAll(async () => {
  if (serviceRoleKey) {
    const admin = adminClient();
    for (const userId of createdUserIds) {
      await admin.auth.admin.deleteUser(userId);
    }
  }
  await pg?.end();
});

describe.skipIf(!serviceRoleKey)('Lot L3 — ACL de table réelle (has_table_privilege)', () => {
  it('anon : aucun privilège ; authenticated : aucun privilège non plus ; service_role : tout', async () => {
    const client = await pgClient();
    const { rows } = await client.query<{
      anon_select: boolean;
      auth_select: boolean;
      auth_insert: boolean;
      service_all: boolean;
    }>(`
      select
        has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
        has_table_privilege('authenticated', c.oid, 'SELECT') as auth_select,
        has_table_privilege('authenticated', c.oid, 'INSERT') as auth_insert,
        (
          has_table_privilege('service_role', c.oid, 'SELECT')
          and has_table_privilege('service_role', c.oid, 'INSERT')
          and has_table_privilege('service_role', c.oid, 'UPDATE')
          and has_table_privilege('service_role', c.oid, 'DELETE')
        ) as service_all
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'store_connection_webhook_token'
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0].anon_select).toBe(false);
    // Contrairement à store_connection/external_ref/ingestion_event (0142), CETTE table n'a AUCUN
    // grant authenticated — même pas SELECT. C'est la différence structurelle du lot.
    expect(rows[0].auth_select).toBe(false);
    expect(rows[0].auth_insert).toBe(false);
    expect(rows[0].service_all).toBe(true);
  });
});

describe.skipIf(!serviceRoleKey)('Lot L3 — preuve n°5 : select réel, anon et authenticated', () => {
  it('anon : select PostgREST ne rend aucune ligne', async () => {
    await setUpFixture();
    const anon = createClient<Database>(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await anon.from('store_connection_webhook_token').select('*');

    // Grant-level (revoke all from anon) : PostgREST répond par une erreur de permission — jamais
    // une ligne, jamais un fragment de secret_hash. Les deux formes de réponse (erreur, ou tableau
    // vide) sont acceptées ; seule la présence de contenu échouerait ce test.
    expect(data ?? []).toHaveLength(0);
    if (!error) {
      expect(data).toEqual([]);
    }
  });

  it('authenticated (membre réel de la boutique propriétaire de la connexion) : select ne rend aucune ligne', async () => {
    const fixture = await setUpFixture();
    const member = await signIn(fixture.email);
    const { data, error } = await member.from('store_connection_webhook_token').select('*');

    expect(data ?? []).toHaveLength(0);
    if (!error) {
      expect(data).toEqual([]);
    }
  });
});

// ============================================================================
// Mutation-testing (preuve n°5, exécuté manuellement en session — voir rapport) : en ajoutant
// temporairement, DIRECTEMENT en base locale (jamais committé), une policy permissive —
//   grant select on public.store_connection_webhook_token to authenticated;
//   create policy l3_mutation_leak on public.store_connection_webhook_token for select
//     to authenticated using (true);
// — le test "authenticated : select ne rend aucune ligne" ci-dessus passe au ROUGE : la ligne
// insérée par setUpFixture() (secret_hash inclus) est retournée en clair. Policy et grant retirés
// immédiatement après (`drop policy l3_mutation_leak ...; revoke select ... from authenticated;`),
// test revérifié vert. Ceci prouve que c'est bien l'ABSENCE de policy + le revoke — pas un hasard
// applicatif (aucun code ne consulte cette table) — qui protège la ligne.
// ============================================================================
