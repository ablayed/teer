// APP-03 / Lot 2 (correctif) — preuve RÉELLE (Postgres + RLS, pas mockée) que le rattachement
// embarqué fonctionne de bout en bout pour un owner légitime, qu'un agent du même tenant en est
// refusé (rôle insuffisant, garde applicative), et que la boutique rattachée est visible/
// modifiable par l'utilisateur qui l'a rattachée mais invisible pour un autre tenant.
//
// `getShopifyAppByClientId` est mocké (aucun vrai client_id Teer Public n'existe encore, cf.
// CLAUDE.md — hors périmètre) : seule l'identité d'app est synthétique, tout le reste (Postgres,
// RLS, shop_seed_memberships, deux vrais utilisateurs Supabase) est réel.
import { signEmbeddedLinkIntent } from '@/lib/shopify/embedded-link-intent';
import type { ShopifyEmbeddedLinkContext } from '@/lib/shopify/embedded-link-write';
import type { Database } from '@/lib/supabase/database.types';
import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SYNTHETIC_PUBLIC_APP = {
  label: 'teer-public' as const,
  clientId: 'rls-test-public-client-sentinel',
  clientSecret: 'rls-test-public-secret-sentinel',
  scopes: 'read_customers,read_orders,read_products',
};

vi.mock('@/lib/shopify/apps', () => ({
  getShopifyAppByClientId: vi.fn((clientId: string | null) =>
    clientId === SYNTHETIC_PUBLIC_APP.clientId ? SYNTHETIC_PUBLIC_APP : null,
  ),
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
    await service.from('shop').delete().in('shop_domain', createdShopDomains);
    createdShopDomains.length = 0;
  }
  await Promise.all(createdUserIds.map((userId) => service.auth.admin.deleteUser(userId)));
  createdUserIds.length = 0;
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

async function getOwnMerchantAccountId(userId: string): Promise<string> {
  const service = serviceClient();
  const { data, error } = await service
    .from('merchant_account')
    .select('id')
    .eq('owner_user_id', userId)
    .single();
  if (error || !data) throw new Error(`no merchant_account for owner ${userId}`);
  return data.id;
}

function signIntentFor(shopDomain: string) {
  const host = Buffer.from('admin.shopify.com/store/rls-test-shop', 'utf8').toString('base64url');
  return signEmbeddedLinkIntent({
    shopDomain,
    clientId: SYNTHETIC_PUBLIC_APP.clientId,
    host,
    exp: Date.now() + 60_000,
  });
}

describe('performShopifyEmbeddedLink — preuve réelle RLS (Postgres)', () => {
  it.skipIf(!process.env.SUPABASE_SERVICE_ROLE_KEY)(
    'owner : rattachement réussit, boutique visible/modifiable par lui, invisible pour un autre tenant ; agent : refusé sans écriture',
    async () => {
      process.env.SHOPIFY_API_SECRET ||= 'rls-test-embedded-link-secret';
      const { performShopifyEmbeddedLink } = await import('@/lib/shopify/embedded-link-write');

      const owner = await createSignedInUser('rls-embedded-link-owner');
      const ownerMerchantAccountId = await getOwnMerchantAccountId(owner.userId);

      const ownerShopDomain = `rls-owner-shop-${Date.now()}.myshopify.com`;
      createdShopDomains.push(ownerShopDomain);
      const ownerResult = await performShopifyEmbeddedLink(
        { intent: signIntentFor(ownerShopDomain), merchantAccountId: ownerMerchantAccountId },
        // Cast TS uniquement (même friction @supabase/ssr vs @supabase/supabase-js documentée dans
        // embedded-link-write.ts) : ce test utilise un vrai client authentifié via mot de passe,
        // pas le client cookie-based du serveur — objet runtime équivalent pour RLS (déterminée par
        // le JWT, jamais par le typage).
        {
          userId: owner.userId,
          supabase: owner.client as unknown as ShopifyEmbeddedLinkContext['supabase'],
        },
      );

      expect(ownerResult.ok).toBe(true);

      const service = serviceClient();
      const { data: createdShop } = await service
        .from('shop')
        .select('id, merchant_account_id, shopify_client_id, status, access_token_encrypted')
        .eq('shop_domain', ownerShopDomain)
        .maybeSingle();
      expect(createdShop).toMatchObject({
        merchant_account_id: ownerMerchantAccountId,
        shopify_client_id: SYNTHETIC_PUBLIC_APP.clientId,
        status: 'active',
        access_token_encrypted: null,
      });
      if (!createdShop) throw new Error('shop was not created');

      // Positif — visibilité : l'owner qui a rattaché la boutique la voit (shop_select :
      // is_shop_member_of, seedé automatiquement par shop_seed_memberships à l'INSERT).
      const { data: visibleToOwner } = await owner.client
        .from('shop')
        .select('id')
        .eq('id', createdShop.id)
        .maybeSingle();
      expect(visibleToOwner).not.toBeNull();

      // Positif — modifiable : l'owner peut mettre à jour cette même boutique (shop_update :
      // current_shop_role(id) in owner/manager, déjà seedé).
      const { error: ownerUpdateError } = await owner.client
        .from('shop')
        .update({ display_name: 'Renommée par owner' })
        .eq('id', createdShop.id);
      expect(ownerUpdateError).toBeNull();

      // Négatif — un autre tenant (owner d'un compte marchand distinct) ne voit rien.
      const otherTenant = await createSignedInUser('rls-embedded-link-other-tenant');
      const { data: visibleToOtherTenant } = await otherTenant.client
        .from('shop')
        .select('id')
        .eq('id', createdShop.id)
        .maybeSingle();
      expect(visibleToOtherTenant).toBeNull();

      // Négatif — un agent du MÊME tenant est refusé par la garde applicative (rôle explicite),
      // avant toute écriture — passe la vérification d'appartenance (n'importe quel rôle), pas
      // celle du rôle. `enforce_single_organization_membership` (BEFORE INSERT sur
      // merchant_member) interdit une double appartenance : on retire d'abord l'appartenance à
      // l'organisation auto-créée par la création du compte (handle_new_user), comme le ferait
      // une acceptation d'invitation réelle, avant de rattacher cet utilisateur comme agent au
      // tenant testé.
      const agent = await createSignedInUser('rls-embedded-link-agent');
      const { error: deleteOwnOrgMembershipError } = await service
        .from('merchant_member')
        .delete()
        .eq('user_id', agent.userId);
      expect(deleteOwnOrgMembershipError).toBeNull();

      const { error: memberError } = await service.from('merchant_member').insert({
        merchant_account_id: ownerMerchantAccountId,
        user_id: agent.userId,
        role: 'agent',
      });
      expect(memberError).toBeNull();

      const agentShopDomain = `rls-agent-shop-${Date.now()}.myshopify.com`;
      const agentResult = await performShopifyEmbeddedLink(
        { intent: signIntentFor(agentShopDomain), merchantAccountId: ownerMerchantAccountId },
        {
          userId: agent.userId,
          supabase: agent.client as unknown as ShopifyEmbeddedLinkContext['supabase'],
        },
      );

      expect(agentResult).toEqual({ ok: false, errorCode: 'insufficient_role' });

      const { data: agentShop } = await service
        .from('shop')
        .select('id')
        .eq('shop_domain', agentShopDomain)
        .maybeSingle();
      expect(agentShop).toBeNull();
    },
  );
});
