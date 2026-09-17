// SEC-SHOP-CLAIM-01 — préemption de domaine Shopify : reproduction inversée, catalogue, gardes.
//
// Commit 1 de ce lot : ces quatre scénarios ont été PROUVÉS exploitables par exécution (un owner de
// A créait ou réécrivait une ligne `shop` au domaine d'une boutique étrangère, et la route de
// session écrivait le jeton hors-ligne de la victime dans la ligne de A). Migration 0155 : INSERT et
// UPDATE retirés à public/anon/authenticated sur `shop` (aucune colonne réaccordée), écritures
// légitimes déplacées dans deux RPC réservées à `service_role`. Les mêmes scénarios, mêmes appels,
// sont ici les attendus INVERSÉS : `42501` au niveau PostgREST, aucune ligne, aucun échange de jeton.
//
// Refus nommé : un appel PostgREST direct n'a pas de couche applicative — `42501` y est le seul
// refus possible. Les refus NOMMÉS sont ceux des chemins applicatifs (performShopifyEmbeddedLink,
// performShopifyAppRelease) et des deux RPC, épinglés plus bas garde par garde.
//
// Ce qui est simulé, et seulement cela : l'identité d'app (client_id/secret synthétiques, jamais
// ceux de Teer Public), la vérification de l'ID token Shopify et l'échange de jeton (aucun appel
// sortant). Ce qui est réel : Postgres, privilèges, RLS, triggers, utilisateurs Supabase, la route
// `GET /api/shopify/embedded/session`, les deux écrivains et leurs RPC.
import type { ShopifyEmbeddedLinkContext } from '@/lib/shopify/embedded-link-write';
import type { Database } from '@/lib/supabase/database.types';
import { createClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { type TestPostgresClient, createTestPostgresClient } from '../helpers/postgres-client';

const SYNTHETIC_PUBLIC_APP = {
  label: 'teer-public' as const,
  clientId: 'sec-shop-claim-01-public-client-sentinel',
  clientSecret: 'sec-shop-claim-01-public-secret-sentinel',
  scopes: 'read_customers,read_orders,read_products',
};

const harness = vi.hoisted(() => ({
  verifiedShopDomain: '',
  tokenExchangeCalls: [] as Array<{ shop: string; idToken: string }>,
}));

vi.mock('@/lib/shopify/apps', () => ({
  getShopifyAppByClientId: vi.fn((clientId: string | null) =>
    clientId === SYNTHETIC_PUBLIC_APP.clientId ? SYNTHETIC_PUBLIC_APP : null,
  ),
}));

vi.mock('@/lib/shopify/session-token', () => ({
  extractShopifySessionAudience: vi.fn(() => SYNTHETIC_PUBLIC_APP.clientId),
  verifyShopifySessionToken: vi.fn(() => ({
    ok: true,
    shopDomain: harness.verifiedShopDomain,
    claims: {
      aud: SYNTHETIC_PUBLIC_APP.clientId,
      dest: `https://${harness.verifiedShopDomain}`,
      exp: 9999999999,
      iat: 1,
      iss: `https://${harness.verifiedShopDomain}/admin`,
      nbf: 1,
      sub: 'victim-shopify-user-sentinel',
    },
  })),
}));

vi.mock('@/lib/shopify/oauth', () => ({
  exchangeIdTokenForOfflineToken: vi.fn(async (input: { shop: string; idToken: string }) => {
    harness.tokenExchangeCalls.push({ shop: input.shop, idToken: input.idToken });
    return {
      accessToken: 'victim-offline-token-sentinel',
      refreshToken: null,
      scope: SYNTHETIC_PUBLIC_APP.scopes,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    };
  }),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const dbUrl =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const password = 'mot-de-passe-test-rls';
const createdUserIds: string[] = [];
const createdShopDomains: string[] = [];
let pg: TestPostgresClient | undefined;

function serviceClient() {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

afterEach(async () => {
  if (!supabaseUrl || !serviceRoleKey) return;
  const service = serviceClient();
  if (createdShopDomains.length > 0) {
    await service.from('store_connection').delete().in('external_identifier', createdShopDomains);
    await service.from('shop').delete().in('shop_domain', createdShopDomains);
    createdShopDomains.length = 0;
  }
  await Promise.all(createdUserIds.map((userId) => service.auth.admin.deleteUser(userId)));
  createdUserIds.length = 0;
  harness.tokenExchangeCalls = [];
});

afterAll(async () => {
  await pg?.end();
});

async function createSignedInUser(emailPrefix: string) {
  const service = serviceClient();
  const email = `${emailPrefix}-${Date.now()}-${crypto.randomUUID()}@example.com`;
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`user creation failed: ${error?.message}`);
  createdUserIds.push(data.user.id);

  const client = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`sign-in failed: ${signInError.message}`);

  return { userId: data.user.id, client };
}

async function createSignedInOwner(emailPrefix: string) {
  const user = await createSignedInUser(emailPrefix);
  // `handle_new_user` crée le locataire et le membre `owner` : le rôle est lu, jamais supposé.
  const { data: member, error: memberError } = await serviceClient()
    .from('merchant_member')
    .select('merchant_account_id, role')
    .eq('user_id', user.userId)
    .single();
  if (memberError || !member) throw new Error(`no membership for ${user.userId}`);
  expect(member.role).toBe('owner');
  return { ...user, merchantAccountId: member.merchant_account_id };
}

// Rattache un nouvel utilisateur au locataire donné avec le rôle demandé. Une seule organisation
// par utilisateur (`enforce_single_organization_membership`) : l'appartenance auto-créée est
// retirée d'abord, comme le fait une acceptation d'invitation. `sync_shop_memberships_for_member`
// crée alors ses `shop_member` sur toutes les boutiques existantes du locataire.
async function createSignedInMember(
  emailPrefix: string,
  merchantAccountId: string,
  role: 'manager' | 'agent',
) {
  const user = await createSignedInUser(emailPrefix);
  const service = serviceClient();
  const { error: deleteError } = await service
    .from('merchant_member')
    .delete()
    .eq('user_id', user.userId);
  if (deleteError) throw new Error(`membership reset failed: ${deleteError.message}`);
  const { error: insertError } = await service
    .from('merchant_member')
    .insert({ merchant_account_id: merchantAccountId, user_id: user.userId, role });
  if (insertError) throw new Error(`membership insert failed: ${insertError.message}`);
  return { ...user, merchantAccountId };
}

async function defaultShopId(merchantAccountId: string) {
  const { data } = await serviceClient()
    .from('shop')
    .select('id')
    .eq('merchant_account_id', merchantAccountId)
    .eq('is_default', true)
    .single();
  if (!data) throw new Error('no default shop seeded by handle_new_user');
  return data.id;
}

function victimDomain(label: string) {
  const domain = `sec-claim-${label}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.myshopify.com`;
  createdShopDomains.push(domain);
  return domain;
}

async function shopRowsFor(domain: string) {
  const { data } = await serviceClient()
    .from('shop')
    .select('id, merchant_account_id, shopify_client_id, status, access_token_encrypted')
    .eq('shop_domain', domain);
  return data ?? [];
}

function sessionRequest(shopDomain: string) {
  return new NextRequest(
    `http://localhost:3000/api/shopify/embedded/session?shop=${encodeURIComponent(shopDomain)}`,
    { headers: { authorization: 'Bearer victim-id-token-sentinel' } },
  );
}

async function signIntentFor(shopDomain: string) {
  const { signEmbeddedLinkIntent } = await import('@/lib/shopify/embedded-link-intent');
  return signEmbeddedLinkIntent({
    shopDomain,
    clientId: SYNTHETIC_PUBLIC_APP.clientId,
    host: Buffer.from('admin.shopify.com/store/sec-claim', 'utf8').toString('base64url'),
    exp: Date.now() + 60_000,
  });
}

function setTestSecrets() {
  process.env.SHOPIFY_API_SECRET ||= 'sec-shop-claim-01-intent-secret';
  // Clé synthétique : le chiffrement réel (AES-256-GCM) s'exécute, avec une clé de test.
  process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY ||= 'a1'.repeat(32);
}

const hasStack = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);

describe('SEC-SHOP-CLAIM-01 — §1.1 préemption par PostgREST (client utilisateur) — REFUSÉE depuis 0155', () => {
  it.skipIf(!hasStack)(
    'owner de A : INSERT shop avec domaine étranger, shopify_client_id de l’app publique, status active, sans jeton — refusé (42501), aucune ligne',
    async () => {
      const attacker = await createSignedInOwner('sec-claim-attacker-active');
      const domain = victimDomain('active');

      const { error } = await attacker.client.from('shop').insert({
        merchant_account_id: attacker.merchantAccountId,
        shop_domain: domain,
        shopify_client_id: SYNTHETIC_PUBLIC_APP.clientId,
        status: 'active',
        access_token_encrypted: null,
        display_name: domain,
      });

      expect(error?.code).toBe('42501');
      expect(await shopRowsFor(domain)).toEqual([]);
    },
  );

  it.skipIf(!hasStack)(
    'variante réinstallation : même INSERT avec status uninstalled — refusé (42501), aucune ligne',
    async () => {
      const attacker = await createSignedInOwner('sec-claim-attacker-uninstalled');
      const domain = victimDomain('uninstalled');

      const { error } = await attacker.client.from('shop').insert({
        merchant_account_id: attacker.merchantAccountId,
        shop_domain: domain,
        shopify_client_id: SYNTHETIC_PUBLIC_APP.clientId,
        status: 'uninstalled',
        display_name: domain,
      });

      expect(error?.code).toBe('42501');
      expect(await shopRowsFor(domain)).toEqual([]);
    },
  );

  it.skipIf(!hasStack)(
    'variante UPDATE : owner de A réécrit sa propre boutique manuelle vers le domaine étranger + client_id — refusé (42501), ligne inchangée',
    async () => {
      const attacker = await createSignedInOwner('sec-claim-attacker-update');
      const domain = victimDomain('update');
      const service = serviceClient();
      const ownShopId = await defaultShopId(attacker.merchantAccountId);
      const { data: before } = await service.from('shop').select('*').eq('id', ownShopId).single();

      const { data: updated, error } = await attacker.client
        .from('shop')
        .update({
          shop_domain: domain,
          shopify_client_id: SYNTHETIC_PUBLIC_APP.clientId,
          status: 'active',
          access_token_encrypted: null,
        })
        .eq('id', ownShopId)
        .select('id')
        .maybeSingle();

      expect(error?.code).toBe('42501');
      expect(updated).toBeNull();
      const { data: after } = await service.from('shop').select('*').eq('id', ownShopId).single();
      expect(after).toEqual(before);
      expect(await shopRowsFor(domain)).toEqual([]);
    },
  );
});

describe('SEC-SHOP-CLAIM-01 — §1.2 résolution de session : aucune ligne préemptée, le jeton va au locataire légitime', () => {
  it.skipIf(!hasStack)(
    'la préemption de A échoue ; l’ID token de la victime n’échange rien (not_configured) ; le rattachement légitime de B réussit et le jeton est écrit dans la ligne de B',
    async () => {
      setTestSecrets();
      const attacker = await createSignedInOwner('sec-claim-attacker-session');
      const victim = await createSignedInOwner('sec-claim-victim-session');
      const domain = victimDomain('session');
      const service = serviceClient();

      // 1. Préemption par A (même appel qu'au §1.1) : refusée.
      const { error: preemptError } = await attacker.client.from('shop').insert({
        merchant_account_id: attacker.merchantAccountId,
        shop_domain: domain,
        shopify_client_id: SYNTHETIC_PUBLIC_APP.clientId,
        status: 'active',
        display_name: domain,
      });
      expect(preemptError?.code).toBe('42501');

      // 2. La victime ouvre l'app : aucune ligne → invitation, jamais d'échange de jeton.
      harness.verifiedShopDomain = domain;
      const { GET } = await import('@/app/api/shopify/embedded/session/route');
      const firstOpen = await GET(sessionRequest(domain));
      const firstBody = await firstOpen.json();
      expect(firstBody.status).toBe('not_configured');
      expect(harness.tokenExchangeCalls).toEqual([]);
      expect(await shopRowsFor(domain)).toEqual([]);

      // 3. Rattachement légitime par B (owner), via le chemin applicatif réel et sa RPC.
      const { performShopifyEmbeddedLink } = await import('@/lib/shopify/embedded-link-write');
      const victimLink = await performShopifyEmbeddedLink(
        { intent: await signIntentFor(domain), merchantAccountId: victim.merchantAccountId },
        {
          userId: victim.userId,
          supabase: victim.client as unknown as ShopifyEmbeddedLinkContext['supabase'],
        },
      );
      expect(victimLink.ok).toBe(true);

      // 4. La victime rouvre l'app : l'échange écrit le jeton dans la ligne de B.
      const secondOpen = await GET(sessionRequest(domain));
      const secondBody = await secondOpen.json();
      expect(secondBody.status).toBe('ready');
      expect(harness.tokenExchangeCalls).toEqual([
        { shop: domain, idToken: 'victim-id-token-sentinel' },
      ]);

      const rows = await shopRowsFor(domain);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.merchant_account_id).toBe(victim.merchantAccountId);
      const { decryptToken } = await import('@/lib/shopify/crypto');
      expect(decryptToken(rows[0]?.access_token_encrypted ?? '')).toBe(
        'victim-offline-token-sentinel',
      );

      const { data: connections } = await service
        .from('store_connection')
        .select('merchant_account_id')
        .eq('platform', 'shopify')
        .eq('external_identifier', domain);
      expect(connections).toEqual([{ merchant_account_id: victim.merchantAccountId }]);

      // A ne voit rien.
      const { data: visibleToAttacker } = await attacker.client
        .from('shop')
        .select('id')
        .eq('shop_domain', domain)
        .maybeSingle();
      expect(visibleToAttacker).toBeNull();
    },
  );
});

describe('SEC-SHOP-CLAIM-01 — aucun client utilisateur n’écrit shop, quel que soit le rôle', () => {
  it.skipIf(!hasStack)(
    'manager de A : INSERT préemptif et UPDATE de sa boutique vers un domaine étranger — refusés (42501)',
    async () => {
      const owner = await createSignedInOwner('sec-claim-manager-tenant');
      const manager = await createSignedInMember(
        'sec-claim-manager',
        owner.merchantAccountId,
        'manager',
      );
      const domain = victimDomain('manager');
      const ownShopId = await defaultShopId(owner.merchantAccountId);

      const { error: insertError } = await manager.client.from('shop').insert({
        merchant_account_id: owner.merchantAccountId,
        shop_domain: domain,
        shopify_client_id: SYNTHETIC_PUBLIC_APP.clientId,
        status: 'active',
        display_name: domain,
      });
      expect(insertError?.code).toBe('42501');

      const { error: updateError } = await manager.client
        .from('shop')
        .update({ shop_domain: domain, shopify_client_id: SYNTHETIC_PUBLIC_APP.clientId })
        .eq('id', ownShopId);
      expect(updateError?.code).toBe('42501');

      expect(await shopRowsFor(domain)).toEqual([]);
    },
  );

  it.skipIf(!hasStack)(
    'owner : aucun jeton ne s’écrit par son client, ni sur sa propre boutique (UPDATE) ni à la création (INSERT)',
    async () => {
      const owner = await createSignedInOwner('sec-claim-token-write');
      const ownShopId = await defaultShopId(owner.merchantAccountId);
      const domain = victimDomain('token');

      const { error: updateError } = await owner.client
        .from('shop')
        .update({
          access_token_encrypted: 'forged-access-token',
          refresh_token_encrypted: 'forged-refresh-token',
          access_token_expires_at: new Date().toISOString(),
          refresh_token_expires_at: new Date().toISOString(),
        })
        .eq('id', ownShopId);
      expect(updateError?.code).toBe('42501');

      const { data: after } = await serviceClient()
        .from('shop')
        .select('access_token_encrypted, refresh_token_encrypted')
        .eq('id', ownShopId)
        .single();
      expect(after).toEqual({ access_token_encrypted: null, refresh_token_encrypted: null });

      const { error: insertError } = await owner.client.from('shop').insert({
        merchant_account_id: owner.merchantAccountId,
        shop_domain: domain,
        access_token_encrypted: 'forged-access-token',
        display_name: domain,
      });
      expect(insertError?.code).toBe('42501');
      expect(await shopRowsFor(domain)).toEqual([]);
    },
  );
});

describe('SEC-SHOP-CLAIM-01 — catalogue : privilèges table, colonne et RPC (0155)', () => {
  type ColumnPrivilegeRow = {
    role: string;
    column_name: string;
    can_insert: boolean;
    can_update: boolean;
  };

  async function catalog() {
    if (!pg) {
      pg = createTestPostgresClient(dbUrl, 'SUPABASE_DB_URL', { connectionTimeoutMillis: 10_000 });
      await pg.connect();
    }
    return pg;
  }

  it.skipIf(!hasStack)(
    'has_table_privilege : INSERT/UPDATE false pour anon et authenticated, true pour service_role ; SELECT inchangé',
    async () => {
      const client = await catalog();
      const { rows } = await client.query<{
        role: string;
        ins: boolean;
        upd: boolean;
        sel: boolean;
      }>(
        `select r as role,
                has_table_privilege(r, 'public.shop', 'INSERT') as ins,
                has_table_privilege(r, 'public.shop', 'UPDATE') as upd,
                has_table_privilege(r, 'public.shop', 'SELECT') as sel
         from unnest(array['anon', 'authenticated', 'service_role']) as r
         order by r`,
      );
      expect(rows).toEqual([
        { role: 'anon', ins: false, upd: false, sel: true },
        { role: 'authenticated', ins: false, upd: false, sel: true },
        { role: 'service_role', ins: true, upd: true, sel: true },
      ]);
    },
  );

  it.skipIf(!hasStack)(
    'has_column_privilege, colonne par colonne : zéro colonne insérable/modifiable pour anon et authenticated (invariant : liste positive vide), toutes pour service_role',
    async () => {
      const client = await catalog();
      const { rows } = await client.query<ColumnPrivilegeRow>(
        `select r as role, a.attname as column_name,
                has_column_privilege(r, 'public.shop', a.attname, 'INSERT') as can_insert,
                has_column_privilege(r, 'public.shop', a.attname, 'UPDATE') as can_update
         from unnest(array['anon', 'authenticated', 'service_role']) as r
         cross join pg_attribute a
         where a.attrelid = 'public.shop'::regclass and a.attnum > 0 and not a.attisdropped
         order by r, a.attnum`,
      );

      // La liste protégée nommée par le mandat doit exister au catalogue : un renommage ferait
      // passer ce test à vide sans cette vérification.
      const protectedColumns = [
        'shop_domain',
        'shopify_client_id',
        'store_kind',
        'status',
        'access_token_encrypted',
        'refresh_token_encrypted',
        'access_token_expires_at',
        'refresh_token_expires_at',
        'installed_at',
        'uninstalled_at',
      ];
      const columns = new Set(rows.map((row) => row.column_name));
      for (const column of protectedColumns) expect(columns.has(column)).toBe(true);

      const writableByClients = rows.filter(
        (row) => row.role !== 'service_role' && (row.can_insert || row.can_update),
      );
      expect(writableByClients).toEqual([]);

      const serviceRoleRows = rows.filter((row) => row.role === 'service_role');
      expect(serviceRoleRows.length).toBeGreaterThanOrEqual(protectedColumns.length);
      expect(serviceRoleRows.every((row) => row.can_insert && row.can_update)).toBe(true);
    },
  );

  it.skipIf(!hasStack)(
    'RPC link_shopify_embedded_shop / release_shopify_shop_app_identity : security invoker, EXECUTE réservé à service_role',
    async () => {
      const client = await catalog();
      const { rows } = await client.query<{
        name: string;
        secdef: boolean;
        anon_x: boolean;
        auth_x: boolean;
        public_x: boolean;
        sr_x: boolean;
      }>(
        `select p.proname as name, p.prosecdef as secdef,
                has_function_privilege('anon', p.oid, 'EXECUTE') as anon_x,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_x,
                coalesce((select bool_or(acl.grantee = 0) from aclexplode(p.proacl) acl), true) as public_x,
                has_function_privilege('service_role', p.oid, 'EXECUTE') as sr_x
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in ('link_shopify_embedded_shop', 'release_shopify_shop_app_identity')
         order by p.proname`,
      );
      expect(rows).toEqual([
        {
          name: 'link_shopify_embedded_shop',
          secdef: false,
          anon_x: false,
          auth_x: false,
          public_x: false,
          sr_x: true,
        },
        {
          name: 'release_shopify_shop_app_identity',
          secdef: false,
          anon_x: false,
          auth_x: false,
          public_x: false,
          sr_x: true,
        },
      ]);
    },
  );
});

describe('SEC-SHOP-CLAIM-01 — link_shopify_embedded_shop : gardes explicites remplaçant la RLS', () => {
  async function link(
    userId: string,
    merchantAccountId: string,
    domain: string,
    clientId?: string,
  ) {
    const { data, error } = await serviceClient().rpc('link_shopify_embedded_shop', {
      p_user_id: userId,
      p_merchant_account_id: merchantAccountId,
      p_shop_domain: domain,
      p_client_id: clientId ?? SYNTHETIC_PUBLIC_APP.clientId,
    });
    expect(error).toBeNull();
    return data;
  }

  it.skipIf(!hasStack)('intention vide : intent_invalid, aucune ligne', async () => {
    const owner = await createSignedInOwner('sec-claim-rpc-invalid');
    expect(await link(owner.userId, owner.merchantAccountId, '  ')).toBe('intent_invalid');
  });

  it.skipIf(!hasStack)(
    'locataire forgé (B passe le locataire de A) : not_a_member, aucune ligne',
    async () => {
      const tenantA = await createSignedInOwner('sec-claim-rpc-forged-a');
      const userB = await createSignedInOwner('sec-claim-rpc-forged-b');
      const domain = victimDomain('rpc-forged');
      expect(await link(userB.userId, tenantA.merchantAccountId, domain)).toBe('not_a_member');
      expect(await shopRowsFor(domain)).toEqual([]);
    },
  );

  it.skipIf(!hasStack)('agent : insufficient_role, aucune ligne', async () => {
    const owner = await createSignedInOwner('sec-claim-rpc-agent-tenant');
    const agent = await createSignedInMember(
      'sec-claim-rpc-agent',
      owner.merchantAccountId,
      'agent',
    );
    const domain = victimDomain('rpc-agent');
    expect(await link(agent.userId, owner.merchantAccountId, domain)).toBe('insufficient_role');
    expect(await shopRowsFor(domain)).toEqual([]);
  });

  it.skipIf(!hasStack)(
    'création puis rattachement répété par le même locataire : inserted puis updated, shop_member semé',
    async () => {
      const owner = await createSignedInOwner('sec-claim-rpc-insert');
      const domain = victimDomain('rpc-insert');
      expect(await link(owner.userId, owner.merchantAccountId, domain)).toBe('inserted');
      const [row] = await shopRowsFor(domain);
      expect(row).toMatchObject({
        merchant_account_id: owner.merchantAccountId,
        shopify_client_id: SYNTHETIC_PUBLIC_APP.clientId,
        status: 'active',
        access_token_encrypted: null,
      });
      const { data: members } = await serviceClient()
        .from('shop_member')
        .select('user_id, role')
        .eq('shop_id', row?.id ?? '');
      expect(members).toEqual([{ user_id: owner.userId, role: 'owner' }]);
      expect(await link(owner.userId, owner.merchantAccountId, domain)).toBe('updated');
    },
  );

  it.skipIf(!hasStack)(
    'boutique d’un autre locataire : ownership_refused, ligne inchangée',
    async () => {
      const first = await createSignedInOwner('sec-claim-rpc-owner-first');
      const second = await createSignedInOwner('sec-claim-rpc-owner-second');
      const domain = victimDomain('rpc-ownership');
      expect(await link(first.userId, first.merchantAccountId, domain)).toBe('inserted');
      expect(await link(second.userId, second.merchantAccountId, domain)).toBe('ownership_refused');
      const rows = await shopRowsFor(domain);
      expect(rows.map((row) => row.merchant_account_id)).toEqual([first.merchantAccountId]);
    },
  );

  it.skipIf(!hasStack)(
    'boutique portant une autre app, même locataire : app_switch_refused, client_id inchangé',
    async () => {
      const owner = await createSignedInOwner('sec-claim-rpc-app-switch');
      const domain = victimDomain('rpc-app-switch');
      expect(await link(owner.userId, owner.merchantAccountId, domain, 'other-app-sentinel')).toBe(
        'inserted',
      );
      expect(await link(owner.userId, owner.merchantAccountId, domain)).toBe('app_switch_refused');
      const [row] = await shopRowsFor(domain);
      expect(row?.shopify_client_id).toBe('other-app-sentinel');
    },
  );

  it.skipIf(!hasStack)(
    'manager du locataire SANS shop_member sur la boutique existante (garde implicite de shop_update) : insufficient_role, ligne inchangée',
    async () => {
      const owner = await createSignedInOwner('sec-claim-rpc-shop-role-tenant');
      const domain = victimDomain('rpc-shop-role');
      // Boutique existante, libérée (client_id NULL), portée par le locataire.
      expect(await link(owner.userId, owner.merchantAccountId, domain)).toBe('inserted');
      const service = serviceClient();
      const [row] = await shopRowsFor(domain);
      await service
        .from('shop')
        .update({ shopify_client_id: null })
        .eq('id', row?.id ?? '');

      const manager = await createSignedInMember(
        'sec-claim-rpc-shop-role-manager',
        owner.merchantAccountId,
        'manager',
      );
      const { error: removeError } = await service
        .from('shop_member')
        .delete()
        .eq('shop_id', row?.id ?? '')
        .eq('user_id', manager.userId);
      expect(removeError).toBeNull();

      expect(await link(manager.userId, owner.merchantAccountId, domain)).toBe('insufficient_role');
      const [after] = await shopRowsFor(domain);
      expect(after?.shopify_client_id).toBeNull();
    },
  );
});

describe('SEC-SHOP-CLAIM-01 — release_shopify_shop_app_identity : gardes explicites remplaçant la RLS', () => {
  async function release(userId: string, shopId: string, oldClientId: string) {
    const { data, error } = await serviceClient().rpc('release_shopify_shop_app_identity', {
      p_user_id: userId,
      p_shop_id: shopId,
      p_old_client_id: oldClientId,
    });
    expect(error).toBeNull();
    return data;
  }

  async function uninstalledShopFor(owner: { userId: string; merchantAccountId: string }) {
    const domain = victimDomain('release');
    const service = serviceClient();
    const { data, error } = await service.rpc('link_shopify_embedded_shop', {
      p_user_id: owner.userId,
      p_merchant_account_id: owner.merchantAccountId,
      p_shop_domain: domain,
      p_client_id: SYNTHETIC_PUBLIC_APP.clientId,
    });
    expect(error).toBeNull();
    expect(data).toBe('inserted');
    const [row] = await shopRowsFor(domain);
    await service
      .from('shop')
      .update({ status: 'uninstalled' })
      .eq('id', row?.id ?? '');
    return row?.id ?? '';
  }

  async function clientIdOf(shopId: string) {
    const { data } = await serviceClient()
      .from('shop')
      .select('shopify_client_id')
      .eq('id', shopId)
      .single();
    return data?.shopify_client_id;
  }

  it.skipIf(!hasStack)('boutique inconnue : shop_not_found', async () => {
    const owner = await createSignedInOwner('sec-claim-release-unknown');
    expect(await release(owner.userId, crypto.randomUUID(), SYNTHETIC_PUBLIC_APP.clientId)).toBe(
      'shop_not_found',
    );
  });

  it.skipIf(!hasStack)(
    'owner d’un autre locataire : not_a_member, client_id inchangé',
    async () => {
      const owner = await createSignedInOwner('sec-claim-release-tenant');
      const other = await createSignedInOwner('sec-claim-release-other');
      const shopId = await uninstalledShopFor(owner);
      expect(await release(other.userId, shopId, SYNTHETIC_PUBLIC_APP.clientId)).toBe(
        'not_a_member',
      );
      expect(await clientIdOf(shopId)).toBe(SYNTHETIC_PUBLIC_APP.clientId);
    },
  );

  it.skipIf(!hasStack)('manager du locataire : insufficient_role, client_id inchangé', async () => {
    const owner = await createSignedInOwner('sec-claim-release-manager-tenant');
    const shopId = await uninstalledShopFor(owner);
    const manager = await createSignedInMember(
      'sec-claim-release-manager',
      owner.merchantAccountId,
      'manager',
    );
    expect(await release(manager.userId, shopId, SYNTHETIC_PUBLIC_APP.clientId)).toBe(
      'insufficient_role',
    );
    expect(await clientIdOf(shopId)).toBe(SYNTHETIC_PUBLIC_APP.clientId);
  });

  it.skipIf(!hasStack)(
    'owner SANS shop_member sur la boutique (garde implicite de shop_update) : insufficient_role, client_id inchangé',
    async () => {
      const owner = await createSignedInOwner('sec-claim-release-no-shop-member');
      const shopId = await uninstalledShopFor(owner);
      const { error } = await serviceClient()
        .from('shop_member')
        .delete()
        .eq('shop_id', shopId)
        .eq('user_id', owner.userId);
      expect(error).toBeNull();
      expect(await release(owner.userId, shopId, SYNTHETIC_PUBLIC_APP.clientId)).toBe(
        'insufficient_role',
      );
      expect(await clientIdOf(shopId)).toBe(SYNTHETIC_PUBLIC_APP.clientId);
    },
  );

  it.skipIf(!hasStack)(
    'compare-and-set : boutique encore active ou ancienne app divergente → state_changed ; cas nominal → released, puis rejeu → state_changed',
    async () => {
      const owner = await createSignedInOwner('sec-claim-release-cas');
      const shopId = await uninstalledShopFor(owner);

      expect(await release(owner.userId, shopId, 'other-app-sentinel')).toBe('state_changed');
      expect(await clientIdOf(shopId)).toBe(SYNTHETIC_PUBLIC_APP.clientId);

      await serviceClient().from('shop').update({ status: 'active' }).eq('id', shopId);
      expect(await release(owner.userId, shopId, SYNTHETIC_PUBLIC_APP.clientId)).toBe(
        'state_changed',
      );
      expect(await clientIdOf(shopId)).toBe(SYNTHETIC_PUBLIC_APP.clientId);

      await serviceClient().from('shop').update({ status: 'uninstalled' }).eq('id', shopId);
      expect(await release(owner.userId, shopId, SYNTHETIC_PUBLIC_APP.clientId)).toBe('released');
      expect(await clientIdOf(shopId)).toBeNull();
      expect(await release(owner.userId, shopId, SYNTHETIC_PUBLIC_APP.clientId)).toBe(
        'state_changed',
      );
    },
  );
});
