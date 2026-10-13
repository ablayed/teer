/**
 * Lectures du membre et du compte marchand (lib/merchant/member-account.ts), et la seule lecture
 * qui reste exportée de lib/actions/merchant.ts (`getMerchantAccount`).
 *
 * Exécutées jusqu'à leur retour contre le VRAI PostgREST local.
 *
 * Ce qui est RÉEL : le constructeur `@supabase/supabase-js`, la fabrique protégée du client
 * service-role, le transport PostgREST, la session du membre pour `getMerchantAccount`.
 * Ce qui est SUBSTITUÉ, et pourquoi : `@/lib/env` (validation Zod au chargement),
 * `createSupabaseServerClient` (il lit des cookies de requête Next ; on lui rend la session
 * réelle voulue, ou un client sans session). Aucune valeur de retour de la base n'est simulée.
 *
 * Propriétés verrouillées :
 *   - cas peuplé : la ligne membre porte le compte et le rôle ; le compte est rendu ;
 *   - cas vide : identifiant inconnu → `null`, jamais une erreur ni une autre ligne ;
 *   - compte supprimé (`deleted_at`) : le membre reste lu, le compte vaut `null` — c'est l'état
 *     sur lequel le layout envoie vers `/onboarding` ;
 *   - `getMerchantAccount` ne prend aucun argument : elle rend le compte de la SESSION, et `null`
 *     sans session. Deux sessions, deux comptes ; aucune ne lit celui de l'autre.
 */

import { randomUUID } from 'node:crypto';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestPostgresClient, createTestPostgresClient } from '../helpers/postgres-client';

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const dbUrl =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const password = `member-account-${randomUUID()}`;
const suite = serviceKey ? describe : describe.skip;
type Client = SupabaseClient<Database>;

const harness = vi.hoisted(() => ({ session: null as unknown }));

vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },
}));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => harness.session,
}));
// La chaîne next-safe-action n'est pas l'objet de cette suite : seules les lectures le sont.
vi.mock('@/lib/actions/safe-action', () => {
  const chain = {
    action: () => async () => undefined,
    inputSchema: () => chain,
    metadata: () => chain,
  };
  return { authActionClient: chain };
});

const createdUsers: string[] = [];
let pg: TestPostgresClient;

function admin(): Client {
  return createClient<Database>(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function anonymous(): Client {
  return createClient<Database>(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function login(email: string): Promise<Client> {
  const client = anonymous();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

async function createTenant(a: Client, label: string) {
  const email = `member-account-${label}-${Date.now()}-${randomUUID()}@example.com`;
  const { data, error } = await a.auth.admin.createUser({ email, email_confirm: true, password });
  if (error || !data.user) throw error ?? new Error('utilisateur de test absent');
  createdUsers.push(data.user.id);
  let merchantId = '';
  for (let i = 0; i < 30 && !merchantId; i++) {
    const account = await a
      .from('merchant_account')
      .select('id')
      .eq('owner_user_id', data.user.id)
      .maybeSingle();
    merchantId = account.data?.id ?? '';
    if (!merchantId) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!merchantId) throw new Error('compte de test absent');
  return { email, merchantId, userId: data.user.id };
}

suite('lectures du membre et du compte marchand', () => {
  let a: Client;
  let first: Awaited<ReturnType<typeof createTenant>>;
  let second: Awaited<ReturnType<typeof createTenant>>;
  let deleted: Awaited<ReturnType<typeof createTenant>>;
  let reads: typeof import('@/lib/merchant/member-account');
  let actions: typeof import('@/lib/actions/merchant');

  beforeAll(async () => {
    if (!serviceKey) return;
    a = admin();
    pg = createTestPostgresClient(dbUrl, 'SUPABASE_DB_URL', { connectionTimeoutMillis: 10_000 });
    await pg.connect();
    first = await createTenant(a, 'a');
    second = await createTenant(a, 'b');
    deleted = await createTenant(a, 'supprime');
    await pg.query('update public.merchant_account set deleted_at = now() where id = $1', [
      deleted.merchantId,
    ]);
    reads = await import('@/lib/merchant/member-account');
    actions = await import('@/lib/actions/merchant');
  }, 120_000);

  beforeEach(() => {
    harness.session = null;
  });

  afterAll(async () => {
    await pg?.end().catch(() => undefined);
    if (!serviceKey) return;
    await Promise.all(createdUsers.splice(0).map((id) => a.auth.admin.deleteUser(id)));
  });

  it('cas peuplé : membre (compte et rôle) puis compte', async () => {
    const member = await reads.getMerchantMemberForUser(first.userId);
    expect(member).toEqual({ merchant_account_id: first.merchantId, role: 'owner' });

    const account = await reads.getMerchantAccountById(first.merchantId);
    expect(account).toMatchObject({
      deleted_at: null,
      id: first.merchantId,
      owner_user_id: first.userId,
    });
  });

  it('cas vide : identifiants inconnus → null', async () => {
    expect(await reads.getMerchantMemberForUser(randomUUID())).toBeNull();
    expect(await reads.getMerchantAccountById(randomUUID())).toBeNull();
  });

  it('compte supprimé : le membre reste lu, le compte vaut null', async () => {
    expect(await reads.getMerchantMemberForUser(deleted.userId)).toEqual({
      merchant_account_id: deleted.merchantId,
      role: 'owner',
    });
    expect(await reads.getMerchantAccountById(deleted.merchantId)).toBeNull();
  });

  it('getMerchantAccount rend le compte de la session, et seulement lui', async () => {
    expect(actions.getMerchantAccount).toHaveLength(0);

    harness.session = await login(first.email);
    expect((await actions.getMerchantAccount())?.id).toBe(first.merchantId);

    harness.session = await login(second.email);
    expect((await actions.getMerchantAccount())?.id).toBe(second.merchantId);
  });

  it('getMerchantAccount sans session : null, sans lire aucun compte', async () => {
    harness.session = anonymous();
    expect(await actions.getMerchantAccount()).toBeNull();
  });
});
