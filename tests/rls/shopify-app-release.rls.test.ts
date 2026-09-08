/**
 * APP-03 / Lot 2 correctif 3, §3-4 — preuve RÉELLE (Postgres + RLS, pas mockée) de
 * `performShopifyAppRelease` (lib/shopify/app-release-write.ts) : le seul chemin de code du dépôt
 * qui remet `shop.shopify_client_id`/`store_connection.platform_app_id` à NULL pour une boutique
 * déjà désinstallée, préalable indispensable pour que `decideShopAppSwitch`
 * (lib/shopify/app-switch-guard.ts) cesse de refuser un rattachement Teer Public sur une boutique
 * déjà possédée par KOBA (cf. rapport de diagnostic KOBA→Teer Public).
 *
 * Chaque test utilise de VRAIS utilisateurs Supabase authentifiés (mot de passe), un vrai client
 * RLS par utilisateur — même pattern que `shopify-embedded-link-rls.rls.test.ts`.
 *
 * Mutations manuelles vérifiées séparément sur `app-release-write.ts` (rapportées dans le rapport
 * de fin de lot, pas ici) : retirer le compare-and-set `platform_app_id` (étape 2, store_connection)
 * SEUL laisse le test de course vert (le compare-and-set `shopify_client_id` de l'étape 3 suffit
 * encore, seul, à garantir l'exclusivité) ; retirer le compare-and-set `shopify_client_id` (étape 3)
 * SEUL laisse également le test vert (symétrique) ; retirer LES DEUX simultanément fait échouer le
 * test de course avec `{ ok: true }` × 2 (double succès observé, aucun jamais bloqué) — les deux
 * predicats sont indépendamment suffisants (défense en profondeur), aucun n'est redondant au sens
 * où le retirer seul ne suffit pas à casser la garantie, mais leur absence CONJOINTE la casse.
 */
import { performShopifyAppRelease } from '@/lib/shopify/app-release-write';
import type { Database } from '@/lib/supabase/database.types';
import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'mot-de-passe-test-app-release';
const createdUserIds: string[] = [];
const createdShopDomains: string[] = [];

const skipIfNoServiceRole = !serviceRoleKey ? it.skip : it;

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

// Retire l'appartenance auto-créée (handle_new_user) puis, si un rôle est fourni, rattache
// l'utilisateur au tenant cible avec ce rôle — sinon le laisse réellement memberless
// (`enforce_single_organization_membership` interdit une double appartenance).
async function reassignMembership(
  userId: string,
  target: { merchantAccountId: string; role: 'owner' | 'manager' | 'agent' } | null,
) {
  const service = serviceClient();
  const { error: deleteError } = await service
    .from('merchant_member')
    .delete()
    .eq('user_id', userId);
  if (deleteError) throw deleteError;

  if (target) {
    const { error: insertError } = await service.from('merchant_member').insert({
      merchant_account_id: target.merchantAccountId,
      user_id: userId,
      role: target.role,
    });
    if (insertError) throw insertError;
  }
}

const OLD_CLIENT_ID = 'koba-client-id-sentinel';

type ShopFixtureOverrides = {
  shopStatus?: string;
  accessTokenEncrypted?: string | null;
  refreshTokenEncrypted?: string | null;
  shopifyClientId?: string | null;
  connectionStatus?: string;
  connectionPlatformAppId?: string | null;
  withToken?: boolean;
};

async function createShopFixture(merchantAccountId: string, overrides: ShopFixtureOverrides = {}) {
  const service = serviceClient();
  const shopDomain = `app-release-${Date.now()}-${crypto.randomUUID()}.myshopify.com`;
  createdShopDomains.push(shopDomain);

  const { data: shop, error: shopError } = await service
    .from('shop')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_domain: shopDomain,
      status: overrides.shopStatus ?? 'uninstalled',
      shopify_client_id:
        overrides.shopifyClientId === undefined ? OLD_CLIENT_ID : overrides.shopifyClientId,
      access_token_encrypted:
        overrides.accessTokenEncrypted === undefined ? null : overrides.accessTokenEncrypted,
      refresh_token_encrypted:
        overrides.refreshTokenEncrypted === undefined ? null : overrides.refreshTokenEncrypted,
    })
    .select('*')
    .single();
  if (shopError || !shop) throw new Error(`shop insert failed: ${shopError?.message}`);

  const { data: connection, error: connectionError } = await service
    .from('store_connection')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shop.id,
      platform: 'shopify',
      external_identifier: shopDomain,
      status: overrides.connectionStatus ?? 'uninstalled',
      platform_app_id:
        overrides.connectionPlatformAppId === undefined
          ? OLD_CLIENT_ID
          : overrides.connectionPlatformAppId,
    })
    .select('*')
    .single();
  if (connectionError || !connection) {
    throw new Error(`store_connection insert failed: ${connectionError?.message}`);
  }

  let tokenId: string | null = null;
  if (overrides.withToken !== false) {
    const { data: token, error: tokenError } = await service
      .from('store_connection_webhook_token')
      .insert({
        store_connection_id: connection.id,
        public_id: `pub-${crypto.randomUUID()}`,
        secret_hash: `hash-${crypto.randomUUID()}`,
      })
      .select('id')
      .single();
    if (tokenError || !token) throw new Error(`token insert failed: ${tokenError?.message}`);
    tokenId = token.id;
  }

  return { shop, connection, tokenId };
}

async function auditRows(merchantAccountId: string, shopId: string) {
  const service = serviceClient();
  const { data, error } = await service
    .from('audit_log')
    .select('action, actor_user_id, resource_id, reason, payload')
    .eq('merchant_account_id', merchantAccountId)
    .eq('resource_type', 'shop')
    .eq('resource_id', shopId)
    .like('action', 'shopify.app_release%');
  if (error) throw error;
  return data ?? [];
}

describe('performShopifyAppRelease — preuve réelle RLS (Postgres)', () => {
  skipIfNoServiceRole(
    'owner : libère une boutique désinstallée sans credential — connexion, jeton et audit corrects',
    async () => {
      const owner = await createSignedInUser('app-release-owner');
      const merchantAccountId = await getOwnMerchantAccountId(owner.userId);
      const { shop, connection, tokenId } = await createShopFixture(merchantAccountId);

      const result = await performShopifyAppRelease(
        { shopId: shop.id },
        { userId: owner.userId, supabase: owner.client as never },
      );

      expect(result).toEqual({ ok: true });

      const service = serviceClient();
      const { data: afterShop } = await service
        .from('shop')
        .select('shopify_client_id, merchant_account_id, id, shop_domain')
        .eq('id', shop.id)
        .single();
      expect(afterShop?.shopify_client_id).toBeNull();
      // Aucune colonne d'identité de tenant/boutique n'est réassignable par cette opération.
      expect(afterShop?.merchant_account_id).toBe(merchantAccountId);
      expect(afterShop?.id).toBe(shop.id);
      expect(afterShop?.shop_domain).toBe(shop.shop_domain);

      const { data: afterConnection } = await service
        .from('store_connection')
        .select('platform_app_id, shop_id, merchant_account_id, id')
        .eq('id', connection.id)
        .single();
      expect(afterConnection?.platform_app_id).toBeNull();
      expect(afterConnection?.shop_id).toBe(shop.id);
      expect(afterConnection?.merchant_account_id).toBe(merchantAccountId);
      expect(afterConnection?.id).toBe(connection.id);

      const { data: afterToken } = await service
        .from('store_connection_webhook_token')
        .select('revoked_at')
        .eq('id', tokenId as string)
        .single();
      expect(afterToken?.revoked_at).not.toBeNull();

      const rows = await auditRows(merchantAccountId, shop.id);
      const actions = rows.map((r) => r.action).sort();
      expect(actions).toEqual(['shopify.app_release_attempted', 'shopify.app_released']);
      for (const row of rows) {
        expect(row.actor_user_id).toBe(owner.userId);
        expect((row.payload as { oldClientId?: string })?.oldClientId).toBe(OLD_CLIENT_ID);
      }
    },
  );

  skipIfNoServiceRole('manager : refusé, aucune écriture', async () => {
    const owner = await createSignedInUser('app-release-owner-for-manager');
    const merchantAccountId = await getOwnMerchantAccountId(owner.userId);
    const { shop } = await createShopFixture(merchantAccountId);

    const manager = await createSignedInUser('app-release-manager');
    await reassignMembership(manager.userId, { merchantAccountId, role: 'manager' });

    const result = await performShopifyAppRelease(
      { shopId: shop.id },
      { userId: manager.userId, supabase: manager.client as never },
    );

    expect(result).toEqual({ ok: false, errorCode: 'insufficient_role' });

    const service = serviceClient();
    const { data: afterShop } = await service
      .from('shop')
      .select('shopify_client_id')
      .eq('id', shop.id)
      .single();
    expect(afterShop?.shopify_client_id).toBe(OLD_CLIENT_ID);
  });

  skipIfNoServiceRole('agent : refusé, aucune écriture', async () => {
    const owner = await createSignedInUser('app-release-owner-for-agent');
    const merchantAccountId = await getOwnMerchantAccountId(owner.userId);
    const { shop } = await createShopFixture(merchantAccountId);

    const agent = await createSignedInUser('app-release-agent');
    await reassignMembership(agent.userId, { merchantAccountId, role: 'agent' });

    const result = await performShopifyAppRelease(
      { shopId: shop.id },
      { userId: agent.userId, supabase: agent.client as never },
    );

    expect(result).toEqual({ ok: false, errorCode: 'insufficient_role' });

    const service = serviceClient();
    const { data: afterShop } = await service
      .from('shop')
      .select('shopify_client_id')
      .eq('id', shop.id)
      .single();
    expect(afterShop?.shopify_client_id).toBe(OLD_CLIENT_ID);
  });

  skipIfNoServiceRole('non-membre : refusé (not_a_member), aucune écriture', async () => {
    const owner = await createSignedInUser('app-release-owner-for-nonmember');
    const merchantAccountId = await getOwnMerchantAccountId(owner.userId);
    const { shop } = await createShopFixture(merchantAccountId);

    const stranger = await createSignedInUser('app-release-stranger');
    await reassignMembership(stranger.userId, null);

    const result = await performShopifyAppRelease(
      { shopId: shop.id },
      { userId: stranger.userId, supabase: stranger.client as never },
    );

    expect(result).toEqual({ ok: false, errorCode: 'not_a_member' });

    const service = serviceClient();
    const { data: afterShop } = await service
      .from('shop')
      .select('shopify_client_id')
      .eq('id', shop.id)
      .single();
    expect(afterShop?.shopify_client_id).toBe(OLD_CLIENT_ID);
  });

  skipIfNoServiceRole(
    "autre tenant (owner d'un autre compte) : refusé, aucune écriture",
    async () => {
      const owner = await createSignedInUser('app-release-owner-target');
      const merchantAccountId = await getOwnMerchantAccountId(owner.userId);
      const { shop } = await createShopFixture(merchantAccountId);

      const otherOwner = await createSignedInUser('app-release-other-owner');

      const result = await performShopifyAppRelease(
        { shopId: shop.id },
        { userId: otherOwner.userId, supabase: otherOwner.client as never },
      );

      // La boutique n'appartient pas à son tenant : invisible sous RLS -> shop_not_found, jamais
      // une distinction qui révélerait son existence chez un autre tenant.
      expect(result).toEqual({ ok: false, errorCode: 'shop_not_found' });

      const service = serviceClient();
      const { data: afterShop } = await service
        .from('shop')
        .select('shopify_client_id')
        .eq('id', shop.id)
        .single();
      expect(afterShop?.shopify_client_id).toBe(OLD_CLIENT_ID);
    },
  );

  skipIfNoServiceRole(
    'boutique encore active : refusée (shop_still_active) — jamais une bascule active→active',
    async () => {
      const owner = await createSignedInUser('app-release-owner-active');
      const merchantAccountId = await getOwnMerchantAccountId(owner.userId);
      const { shop } = await createShopFixture(merchantAccountId, {
        shopStatus: 'active',
        accessTokenEncrypted: 'still-connected',
      });

      const result = await performShopifyAppRelease(
        { shopId: shop.id },
        { userId: owner.userId, supabase: owner.client as never },
      );

      expect(result).toEqual({ ok: false, errorCode: 'shop_still_active' });

      const service = serviceClient();
      const { data: afterShop } = await service
        .from('shop')
        .select('shopify_client_id')
        .eq('id', shop.id)
        .single();
      expect(afterShop?.shopify_client_id).toBe(OLD_CLIENT_ID);
    },
  );

  skipIfNoServiceRole('credential encore présent : refusée (credential_present)', async () => {
    const owner = await createSignedInUser('app-release-owner-credential');
    const merchantAccountId = await getOwnMerchantAccountId(owner.userId);
    const { shop } = await createShopFixture(merchantAccountId, {
      accessTokenEncrypted: 'stale-token-not-cleared',
    });

    const result = await performShopifyAppRelease(
      { shopId: shop.id },
      { userId: owner.userId, supabase: owner.client as never },
    );

    expect(result).toEqual({ ok: false, errorCode: 'credential_present' });
  });

  skipIfNoServiceRole(
    'shopify_client_id et platform_app_id divergents : refusée (connection_app_mismatch)',
    async () => {
      const owner = await createSignedInUser('app-release-owner-mismatch');
      const merchantAccountId = await getOwnMerchantAccountId(owner.userId);
      const { shop } = await createShopFixture(merchantAccountId, {
        connectionPlatformAppId: 'une-app-differente',
      });

      const result = await performShopifyAppRelease(
        { shopId: shop.id },
        { userId: owner.userId, supabase: owner.client as never },
      );

      expect(result).toEqual({ ok: false, errorCode: 'connection_app_mismatch' });

      const service = serviceClient();
      const { data: afterShop } = await service
        .from('shop')
        .select('shopify_client_id')
        .eq('id', shop.id)
        .single();
      expect(afterShop?.shopify_client_id).toBe(OLD_CLIENT_ID);
    },
  );

  skipIfNoServiceRole(
    'course — deux appels concurrents : exactement un gagnant, jamais deux, jamais aucun état incohérent',
    async () => {
      const owner = await createSignedInUser('app-release-owner-race');
      const merchantAccountId = await getOwnMerchantAccountId(owner.userId);
      const { shop } = await createShopFixture(merchantAccountId);

      const [a, b] = await Promise.all([
        performShopifyAppRelease(
          { shopId: shop.id },
          { userId: owner.userId, supabase: owner.client as never },
        ),
        performShopifyAppRelease(
          { shopId: shop.id },
          { userId: owner.userId, supabase: owner.client as never },
        ),
      ]);

      const results = [a, b];
      const successes = results.filter((r) => r.ok);
      const failures = results.filter((r) => !r.ok);
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ ok: false, errorCode: 'write_failed' });

      const service = serviceClient();
      // Ordre fail-closed : le perdant de la course a échoué à l'étape 2 (store_connection) —
      // shop.shopify_client_id ne peut donc avoir été touché QUE par le gagnant, jamais les deux.
      const { data: afterShop } = await service
        .from('shop')
        .select('shopify_client_id')
        .eq('id', shop.id)
        .single();
      expect(afterShop?.shopify_client_id).toBeNull();

      // Un seul enregistrement de résultat réussi — le perdant n'a jamais atteint l'étape 4.
      const rows = await auditRows(merchantAccountId, shop.id);
      const releasedRows = rows.filter((r) => r.action === 'shopify.app_released');
      expect(releasedRows).toHaveLength(1);
    },
  );

  skipIfNoServiceRole(
    'rejeu séquentiel après succès : refusé (no_app_to_release), jamais une réassignation silencieuse',
    async () => {
      const owner = await createSignedInUser('app-release-owner-replay');
      const merchantAccountId = await getOwnMerchantAccountId(owner.userId);
      const { shop } = await createShopFixture(merchantAccountId);

      const first = await performShopifyAppRelease(
        { shopId: shop.id },
        { userId: owner.userId, supabase: owner.client as never },
      );
      expect(first).toEqual({ ok: true });

      const second = await performShopifyAppRelease(
        { shopId: shop.id },
        { userId: owner.userId, supabase: owner.client as never },
      );
      expect(second).toEqual({ ok: false, errorCode: 'no_app_to_release' });
    },
  );

  skipIfNoServiceRole(
    'reprise idempotente — connexion déjà libérée par un échec intermédiaire précédent : termine le travail',
    async () => {
      const owner = await createSignedInUser('app-release-owner-resume');
      const merchantAccountId = await getOwnMerchantAccountId(owner.userId);
      // Simule l'état laissé par un échec entre l'étape 2 (réussie) et l'étape 3 (jamais atteinte)
      // d'un run précédent : connexion déjà libérée, shop pas encore mise à jour.
      const { shop } = await createShopFixture(merchantAccountId, {
        connectionPlatformAppId: null,
      });

      const result = await performShopifyAppRelease(
        { shopId: shop.id },
        { userId: owner.userId, supabase: owner.client as never },
      );

      expect(result).toEqual({ ok: true });

      const service = serviceClient();
      const { data: afterShop } = await service
        .from('shop')
        .select('shopify_client_id')
        .eq('id', shop.id)
        .single();
      expect(afterShop?.shopify_client_id).toBeNull();
    },
  );
});
