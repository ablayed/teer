import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

// Lot S4 — les 4 routines SECURITY DEFINER×authenticated sans aucun test connu
// à l'énumération (docs/security/s4-enumeration-definer-authenticated.md).
// Arbitrage du porteur : ratchet pour les 35 autres, mais ces 4 restent DANS LE
// PÉRIMÈTRE de ce lot — pas versées à l'arriéré.
//
// Chaque définition a été lue en direct sur la base locale
// (pg_get_functiondef) avant d'écrire un seul test — jamais deviné depuis une
// migration. Aucune des quatre n'a révélé de défaut réel (voir le détail par
// routine ci-dessous) ; il ne s'agissait donc, dans les quatre cas, que d'une
// preuve manquante, pas d'une correction à remonter.

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'lot-s4-rls-test-pw';
const createdUserIds: string[] = [];

const skipIfNoServiceRole = !serviceRoleKey ? it.skip : it;

type AdminClient = SupabaseClient<Database>;

function adminClient(): AdminClient {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createConfirmedUser(admin: AdminClient, email: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('User creation failed');
  createdUserIds.push(data.user.id);
  return data.user.id;
}

async function waitForMerchantAccount(admin: AdminClient, userId: string) {
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
  throw new Error('merchant_account not found after 20 retries');
}

async function waitForDefaultShop(admin: AdminClient, merchantAccountId: string) {
  for (let i = 0; i < 30; i++) {
    const { data } = await admin
      .from('shop')
      .select('id')
      .eq('merchant_account_id', merchantAccountId)
      .eq('is_default', true)
      .limit(1)
      .maybeSingle();
    if (data?.id) return data.id as string;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('default shop not found after 30 retries');
}

async function signIn(email: string) {
  const client = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  await client.auth.signInWithPassword({ email, password });
  return client;
}

async function createOwnerFixture(label: string) {
  const admin = adminClient();
  const email = `lot-s4-rls-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  const shopId = await waitForDefaultShop(admin, merchantAccountId);
  return { admin, email, merchantAccountId, userId, shopId };
}

async function createShop(admin: AdminClient, merchantAccountId: string, domain: string) {
  const { data, error } = await admin
    .from('shop')
    .insert({
      access_token_encrypted: 'enc',
      merchant_account_id: merchantAccountId,
      scopes: 'read_orders',
      shop_domain: domain,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('shop insert failed');
  return data.id as string;
}

type GenericRpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

function rpcOf(client: { rpc: SupabaseClient<Database>['rpc'] }) {
  return client.rpc.bind(client) as unknown as GenericRpc;
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id);
  }
  createdUserIds.length = 0;
});

// ── is_shop_member_of(p_shop_id) ──────────────────────────────────────────
// Lecture. Confronte p_shop_id (fourni par le client) à une ligne réelle
// shop_member scopée par auth.uid() (jamais un id transmis) et croise
// merchant_account_id entre shop_member et shop. Aucun défaut trouvé à la
// lecture — c'est la primitive elle-même qui fait ce croisement id-client/
// parent-autoritaire ; ce test prouve qu'elle le fait réellement, sur les
// deux axes.
describe("Lot S4 — is_shop_member_of(p_shop_id) — la primitive d'appartenance elle-même", () => {
  skipIfNoServiceRole('vrai pour sa propre boutique par défaut', async () => {
    const { email, shopId } = await createOwnerFixture('ismember-own');
    const owner = await signIn(email);
    const { data, error } = await rpcOf(owner)('is_shop_member_of', { p_shop_id: shopId });
    expect(error).toBeNull();
    expect(data).toBe(true);
  });

  skipIfNoServiceRole(
    "faux pour une autre boutique du même compte dont l'accès a été retiré",
    async () => {
      const { admin, email, merchantAccountId, userId } =
        await createOwnerFixture('ismember-cross-shop');
      const owner = await signIn(email);
      const shopB = await createShop(
        admin,
        merchantAccountId,
        `s4-ismember-shopb-${Date.now()}.internal`,
      );
      await admin.from('shop_member').delete().eq('shop_id', shopB).eq('user_id', userId);

      const { data, error } = await rpcOf(owner)('is_shop_member_of', { p_shop_id: shopB });
      expect(error).toBeNull();
      expect(data).toBe(false);
    },
  );

  skipIfNoServiceRole("faux pour une boutique d'un autre compte entièrement", async () => {
    const { email: emailA } = await createOwnerFixture('ismember-a');
    const { shopId: shopIdB } = await createOwnerFixture('ismember-b');
    const ownerA = await signIn(emailA);

    const { data, error } = await rpcOf(ownerA)('is_shop_member_of', { p_shop_id: shopIdB });
    expect(error).toBeNull();
    expect(data).toBe(false);
  });
});

// ── list_my_stores() ───────────────────────────────────────────────────────
// Aucun paramètre — structurellement immunisée contre la classe de défaut
// visée par ce lot (rien à falsifier, la portée vient uniquement de
// auth.uid()). Le seul risque testable est une fuite : retourner une
// boutique dont l'appelant n'est pas membre.
describe('Lot S4 — list_my_stores() — sans paramètre, portée uniquement par auth.uid()', () => {
  skipIfNoServiceRole("ne retourne jamais la boutique d'un autre compte", async () => {
    const { email: emailA, shopId: shopIdA } = await createOwnerFixture('liststores-a');
    const { shopId: shopIdB } = await createOwnerFixture('liststores-b');
    const ownerA = await signIn(emailA);

    const { data, error } = await rpcOf(ownerA)('list_my_stores', {});
    expect(error).toBeNull();
    const ids = (data as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(shopIdA);
    expect(ids).not.toContain(shopIdB);
  });

  skipIfNoServiceRole(
    "ne retourne pas une boutique du même compte dont l'accès a été retiré",
    async () => {
      const { admin, email, merchantAccountId, userId, shopId } =
        await createOwnerFixture('liststores-cross-shop');
      const owner = await signIn(email);
      const shopB = await createShop(
        admin,
        merchantAccountId,
        `s4-liststores-shopb-${Date.now()}.internal`,
      );
      await admin.from('shop_member').delete().eq('shop_id', shopB).eq('user_id', userId);

      const { data, error } = await rpcOf(owner)('list_my_stores', {});
      expect(error).toBeNull();
      const ids = (data as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toContain(shopId);
      expect(ids).not.toContain(shopB);
    },
  );
});

// ── cash_aging(p_merchant) ─────────────────────────────────────────────────
// Écriture nulle (lecture pure), mais argent par livreur — garde par
// current_member_role(p_merchant) IN ('owner','manager'), appliquée en CTE ET
// en filtre final. Un appelant non autorisé (rôle NULL ou hors owner/manager)
// obtient un jeu de résultats VIDE, jamais une erreur — vérifié NULL-safe
// (current_member_role retourne NULL pour un non-membre ; "NULL in (...)"
// n'est jamais vrai, cf. CLAUDE.md, garde NULL-safe). Pas de paramètre
// boutique dans cette fonction (driver n'a pas de shop_id, N-N via
// driver_shop, cf. CLAUDE.md) — l'axe "autre boutique" n'a structurellement
// pas de sens ici ; remplacé par l'axe "même compte mais rôle insuffisant".
describe('Lot S4 — cash_aging(p_merchant) — garde de rôle NULL-safe, aucun axe boutique (structurel)', () => {
  skipIfNoServiceRole("vide pour un compte entièrement étranger à l'appelant", async () => {
    const { email: emailA } = await createOwnerFixture('cashaging-a');
    const { merchantAccountId: merchantB } = await createOwnerFixture('cashaging-b');
    const ownerA = await signIn(emailA);

    const { data, error } = await rpcOf(ownerA)('cash_aging', { p_merchant: merchantB });
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  skipIfNoServiceRole(
    'vide pour un membre du même compte dont le rôle est agent (hors owner/manager)',
    async () => {
      const { admin, merchantAccountId, shopId } =
        await createOwnerFixture('cashaging-agent-owner');
      const agentUserId = await createConfirmedUser(
        admin,
        `lot-s4-rls-cashaging-agent-${Date.now()}@example.com`,
      );
      await admin.from('shop_member').insert({
        shop_id: shopId,
        user_id: agentUserId,
        merchant_account_id: merchantAccountId,
        role: 'agent',
      });
      const { data: agentAuth } = await admin.auth.admin.getUserById(agentUserId);
      const agentEmail = agentAuth?.user?.email;
      if (!agentEmail) throw new Error('agent email introuvable');
      await admin.auth.admin.updateUserById(agentUserId, { password });
      const agent = await signIn(agentEmail);

      const { data, error } = await rpcOf(agent)('cash_aging', { p_merchant: merchantAccountId });
      expect(error).toBeNull();
      expect(data).toEqual([]);
    },
  );

  skipIfNoServiceRole(
    'réussit (jeu vide ou non, sans erreur) pour le owner de son propre compte',
    async () => {
      const { email, merchantAccountId } = await createOwnerFixture('cashaging-legit');
      const owner = await signIn(email);

      const { error } = await rpcOf(owner)('cash_aging', { p_merchant: merchantAccountId });
      expect(error).toBeNull();
    },
  );
});

// ── purge_pcd_access_audit(p_before, p_batch_size) ─────────────────────────
// EXECUTE accordé à `authenticated` (constaté, has_function_privilege) alors
// que la garde interne est un rejet inconditionnel de tout appelant dont
// auth.role() <> 'service_role' — donc AUCUN axe boutique/compte n'a de sens
// ici : la garde ne dépend d'aucun identifiant transmis, elle bloque tout le
// monde sauf service_role, quel que soit le tenant. Testé : un membre légitime
// authentifié (n'importe lequel) est rejeté et ne supprime rien ; service_role
// réussit (contrôle positif). Écart de posture noté dans le rapport S4 (grant
// authenticated plus large que nécessaire vis-à-vis de la doctrine du projet
// pour ce type de fonction — cf. AUTHENTICATED_FORBIDDEN existant) — ce n'est
// PAS un défaut exploitable (rejet inconditionnel prouvé ici), donc pas
// remonté comme "arrête et remonte".
describe('Lot S4 — purge_pcd_access_audit — rejet inconditionnel hors service_role, aucun axe tenant', () => {
  skipIfNoServiceRole(
    "refuse un appelant authenticated légitime (n'importe quel rôle, n'importe quel tenant), aucune suppression",
    async () => {
      const { admin, email } = await createOwnerFixture('purgeaudit-authenticated');
      const owner = await signIn(email);

      const before = await admin
        .from('pcd_access_audit')
        .select('id', { count: 'exact', head: true });
      const countBefore = before.count ?? 0;

      const { data, error } = await rpcOf(owner)('purge_pcd_access_audit', {
        p_before: new Date().toISOString(),
        p_batch_size: 10,
      });

      expect(error).not.toBeNull();
      expect(data).toBeNull();

      const after = await admin
        .from('pcd_access_audit')
        .select('id', { count: 'exact', head: true });
      expect(after.count ?? 0).toBe(countBefore);
    },
  );

  skipIfNoServiceRole('réussit pour service_role (contrôle positif)', async () => {
    const admin = adminClient();
    const { error } = await rpcOf(admin)('purge_pcd_access_audit', {
      p_before: '1970-01-01T00:00:00Z', // rien d'aussi vieux dans le seed local — 0 ligne supprimée, mais aucune erreur
      p_batch_size: 10,
    });
    expect(error).toBeNull();
  });
});
