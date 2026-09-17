// SEC-SHOP-CLAIM-01 — commit 1 : REPRODUCTION de la préemption de domaine Shopify, par exécution.
//
// Ce fichier ne corrige rien. Il mesure, contre le vrai PostgREST local et la RLS réelle, si un
// membre `owner` d'un locataire A peut créer une ligne `shop` portant le domaine d'une boutique
// qu'il ne possède pas, puis si la route de session embarquée écrit le jeton hors-ligne de la
// victime dans CETTE ligne. Les assertions décrivent l'état mesuré AVANT correctif ; le commit 2
// les inversera (le refus devient l'attendu), jamais les supprimera.
//
// Ce qui est simulé, et seulement cela : l'identité d'app (client_id/secret synthétiques, jamais
// ceux de Teer Public), la vérification de l'ID token Shopify (renvoie le domaine victime) et
// l'échange de jeton (renvoie un jeton sentinelle — aucun appel sortant). Ce qui est réel :
// Postgres, RLS, triggers (`shop_seed_memberships`), deux vrais utilisateurs Supabase, la route
// `GET /api/shopify/embedded/session` elle-même et son client service-role.
import type { ShopifyEmbeddedLinkContext } from '@/lib/shopify/embedded-link-write';
import type { Database } from '@/lib/supabase/database.types';
import { createClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
const password = 'mot-de-passe-test-rls';
const createdUserIds: string[] = [];
const createdShopDomains: string[] = [];

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

async function createSignedInOwner(emailPrefix: string) {
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

  // `handle_new_user` crée le locataire et le membre `owner` : le rôle est lu, jamais supposé.
  const { data: member, error: memberError } = await service
    .from('merchant_member')
    .select('merchant_account_id, role')
    .eq('user_id', data.user.id)
    .single();
  if (memberError || !member) throw new Error(`no membership for ${data.user.id}`);
  expect(member.role).toBe('owner');

  return { userId: data.user.id, client, merchantAccountId: member.merchant_account_id };
}

function victimDomain(label: string) {
  const domain = `sec-claim-${label}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.myshopify.com`;
  createdShopDomains.push(domain);
  return domain;
}

function sessionRequest(shopDomain: string) {
  return new NextRequest(
    `http://localhost:3000/api/shopify/embedded/session?shop=${encodeURIComponent(shopDomain)}`,
    { headers: { authorization: 'Bearer victim-id-token-sentinel' } },
  );
}

const hasStack = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);

describe('SEC-SHOP-CLAIM-01 — §1.1 préemption par PostgREST (client utilisateur, RLS réelle)', () => {
  it.skipIf(!hasStack)(
    'owner de A : INSERT shop avec domaine étranger, shopify_client_id de l’app publique, status active, sans jeton — MESURÉ : accepté',
    async () => {
      const attacker = await createSignedInOwner('sec-claim-attacker-active');
      const domain = victimDomain('active');

      // `.insert()` sans `.select()` : même forme que le chemin légitime
      // (lib/shopify/embedded-link-write.ts), qui documente que RETURNING échoue avant le seed
      // des `shop_member`. Aucune astuce : c'est l'appel PostgREST le plus direct.
      const { error } = await attacker.client.from('shop').insert({
        merchant_account_id: attacker.merchantAccountId,
        shop_domain: domain,
        shopify_client_id: SYNTHETIC_PUBLIC_APP.clientId,
        status: 'active',
        access_token_encrypted: null,
        display_name: domain,
      });

      expect(error).toBeNull();

      const { data: row } = await serviceClient()
        .from('shop')
        .select('merchant_account_id, shopify_client_id, status, access_token_encrypted')
        .eq('shop_domain', domain)
        .single();
      expect(row).toEqual({
        merchant_account_id: attacker.merchantAccountId,
        shopify_client_id: SYNTHETIC_PUBLIC_APP.clientId,
        status: 'active',
        access_token_encrypted: null,
      });
    },
  );

  it.skipIf(!hasStack)(
    'variante réinstallation : même INSERT avec status uninstalled — MESURÉ : accepté',
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

      expect(error).toBeNull();
    },
  );

  it.skipIf(!hasStack)(
    'variante UPDATE : owner de A réécrit sa propre boutique manuelle vers le domaine étranger + client_id — MESURÉ : accepté',
    async () => {
      const attacker = await createSignedInOwner('sec-claim-attacker-update');
      const domain = victimDomain('update');
      const service = serviceClient();

      const { data: ownShop } = await service
        .from('shop')
        .select('id, shop_domain')
        .eq('merchant_account_id', attacker.merchantAccountId)
        .eq('is_default', true)
        .single();
      if (!ownShop) throw new Error('no default shop seeded by handle_new_user');

      const { data: updated, error } = await attacker.client
        .from('shop')
        .update({
          shop_domain: domain,
          shopify_client_id: SYNTHETIC_PUBLIC_APP.clientId,
          status: 'active',
          access_token_encrypted: null,
        })
        .eq('id', ownShop.id)
        .select('id')
        .maybeSingle();

      expect(error).toBeNull();
      expect(updated?.id).toBe(ownShop.id);
    },
  );
});

describe('SEC-SHOP-CLAIM-01 — §1.2 résolution de session sur la ligne préemptée (route réelle, base réelle)', () => {
  it.skipIf(!hasStack)(
    'l’ID token de la victime déclenche l’échange ; le jeton hors-ligne est écrit dans la ligne du locataire A, qui obtient aussi la store_connection — et le rattachement légitime de B est ensuite refusé',
    async () => {
      process.env.SHOPIFY_API_SECRET ||= 'sec-shop-claim-01-intent-secret';
      // Clé synthétique : le chiffrement réel (AES-256-GCM) s'exécute, avec une clé de test.
      process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY ||= 'a1'.repeat(32);
      const attacker = await createSignedInOwner('sec-claim-attacker-session');
      const victim = await createSignedInOwner('sec-claim-victim-session');
      const domain = victimDomain('session');
      const service = serviceClient();

      // 1. Préemption par A (même appel qu'au §1.1).
      const { error: preemptError } = await attacker.client.from('shop').insert({
        merchant_account_id: attacker.merchantAccountId,
        shop_domain: domain,
        shopify_client_id: SYNTHETIC_PUBLIC_APP.clientId,
        status: 'active',
        display_name: domain,
      });
      expect(preemptError).toBeNull();

      // 2. La victime ouvre l'app : Shopify lui délivre un ID token signé pour SON domaine.
      harness.verifiedShopDomain = domain;
      const { GET } = await import('@/app/api/shopify/embedded/session/route');
      const response = await GET(sessionRequest(domain));
      const body = await response.json();

      // La victime voit « Prête ».
      expect(response.status).toBe(200);
      expect(body.status).toBe('ready');
      expect(body.shop.domain).toBe(domain);

      // L'échange a bien été fait avec l'ID token de la victime, pour le domaine de la victime.
      expect(harness.tokenExchangeCalls).toEqual([
        { shop: domain, idToken: 'victim-id-token-sentinel' },
      ]);

      // 3. MESURE DÉCISIVE : dans quelle ligne le jeton hors-ligne a-t-il été écrit ?
      const { data: shopRows } = await service
        .from('shop')
        .select('id, merchant_account_id, access_token_encrypted, status')
        .eq('shop_domain', domain);
      expect(shopRows).toHaveLength(1);
      const [row] = shopRows ?? [];
      expect(row?.merchant_account_id).toBe(attacker.merchantAccountId);
      expect(row?.access_token_encrypted).not.toBeNull();
      expect(row?.status).toBe('active');

      // Le chiffré est bien celui du jeton de la victime (déchiffrement réel, pas une présence).
      const { decryptToken } = await import('@/lib/shopify/crypto');
      expect(decryptToken(row?.access_token_encrypted ?? '')).toBe('victim-offline-token-sentinel');

      // La connexion canonique (support de l'ingestion) est rattachée au locataire A.
      const { data: connections } = await service
        .from('store_connection')
        .select('merchant_account_id, shop_id, status')
        .eq('platform', 'shopify')
        .eq('external_identifier', domain);
      expect(connections).toEqual([
        { merchant_account_id: attacker.merchantAccountId, shop_id: row?.id, status: 'active' },
      ]);

      // Le locataire A lit la boutique préemptée sous sa propre session RLS.
      const { data: visibleToAttacker } = await attacker.client
        .from('shop')
        .select('id')
        .eq('id', row?.id ?? '')
        .maybeSingle();
      expect(visibleToAttacker).not.toBeNull();

      // 4. La victime, owner de B, tente le rattachement légitime : la garde de propriété
      // (premier locataire à lier la boutique la garde) protège A.
      const { signEmbeddedLinkIntent } = await import('@/lib/shopify/embedded-link-intent');
      const { performShopifyEmbeddedLink } = await import('@/lib/shopify/embedded-link-write');
      const intent = signEmbeddedLinkIntent({
        shopDomain: domain,
        clientId: SYNTHETIC_PUBLIC_APP.clientId,
        host: Buffer.from('admin.shopify.com/store/sec-claim', 'utf8').toString('base64url'),
        exp: Date.now() + 60_000,
      });
      const victimLink = await performShopifyEmbeddedLink(
        { intent, merchantAccountId: victim.merchantAccountId },
        {
          userId: victim.userId,
          supabase: victim.client as unknown as ShopifyEmbeddedLinkContext['supabase'],
        },
      );
      expect(victimLink).toEqual({ ok: false, errorCode: 'ownership_refused' });

      // Aucune ligne n'a changé de locataire.
      const { data: afterVictim } = await service
        .from('shop')
        .select('merchant_account_id')
        .eq('shop_domain', domain)
        .single();
      expect(afterVictim?.merchant_account_id).toBe(attacker.merchantAccountId);
    },
  );
});
