// APP-03 / Lot 2 correctif 3, §3 — écriture de la libération contrôlée d'identité d'app Shopify.
//
// Isolé de next-safe-action (pas de 'use server'), même discipline que
// `lib/shopify/embedded-link-write.ts` : reste unitairement/RLS-testable en appelant la fonction
// directement.
//
// Client utilisateur (RLS) partout où le schéma le permet : lecture de `shop` (policy
// `shop_select`), lecture de `store_connection` (policy `store_connection_select`), écriture de
// `shop.shopify_client_id` (policy `shop_update`, owner/manager — la garde applicative en amont
// est déjà plus stricte, owner seul). Service-role UNIQUEMENT pour l'écriture de
// `store_connection` et `store_connection_webhook_token` — mesuré par lecture directe du catalogue
// local (`\d public.store_connection` / `\d public.store_connection_webhook_token`) : aucune des
// deux tables ne porte de policy INSERT/UPDATE pour `authenticated`, seule `store_connection_select`
// existe. Un client RLS ne pourrait donc jamais modifier ces deux tables — ce n'est pas un choix,
// c'est la seule voie possible pour ces deux écritures précises, comme pour `processAppUninstalledCore`
// et `completeCredentialsLink` qui écrivent déjà `store_connection` en service-role pour la même
// raison structurelle.
//
// Ordre d'écriture, fail-closed, jamais transactionnel (aucune RPC n'existe pour cette opération —
// en écrire une serait une migration, hors périmètre de ce mandat) :
//   1. audit_log « tentative » — AVANT toute mutation, trace durable même si tout le reste échoue.
//   2. store_connection.platform_app_id = NULL + révocation du jeton opaque s'il existe.
//   3. shop.shopify_client_id = NULL — EN DERNIER : si l'étape 2 échoue, `shop` garde l'ancienne
//      app et reste donc bloquée par `decideShopAppSwitch` — jamais un état où `shop` est libérée
//      mais `store_connection` reste sur l'ancienne app (l'inverse serait dangereux : un webhook
//      opaque de l'ancienne app pourrait encore résoudre une connexion dont plus rien côté `shop`
//      ne rattache à cette app).
//   4. audit_log « résultat » — seulement si les étapes 2 et 3 réussissent.
// Chaque update est un compare-and-set (predicate sur les valeurs lues) : zéro ligne modifiée est
// un échec fermé, jamais un succès silencieux. Idempotent : rejouer l'opération depuis l'état
// partiel (connexion déjà libérée, shop pas encore mise à jour) est accepté par
// `decideAppRelease` et termine le travail restant.
import { decideAppRelease } from '@/lib/shopify/app-release-guard';
import { createProtectedSupabaseClient } from '@/lib/supabase/protected-client';
import type { createSupabaseServerClient } from '@/lib/supabase/server';
import * as Sentry from '@sentry/nextjs';

function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required for the Shopify app release write`);
  }

  return value;
}

function createSupabaseAdminClient() {
  return createProtectedSupabaseClient(
    getRequiredEnv('NEXT_PUBLIC_SUPABASE_URL'),
    getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: { autoRefreshToken: false, persistSession: false },
    },
  );
}

export type ShopifyAppReleaseInput = {
  shopId: string;
};

export type ShopifyAppReleaseContext = {
  userId: string;
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
};

export type ShopifyAppReleaseResult =
  | { ok: true }
  | {
      ok: false;
      errorCode:
        | 'not_a_member'
        | 'insufficient_role'
        | 'shop_not_found'
        | 'wrong_tenant'
        | 'shop_still_active'
        | 'credential_present'
        | 'no_app_to_release'
        | 'connection_missing'
        | 'connection_still_active'
        | 'connection_app_mismatch'
        | 'write_failed';
    };

export async function performShopifyAppRelease(
  input: ShopifyAppReleaseInput,
  ctx: ShopifyAppReleaseContext,
): Promise<ShopifyAppReleaseResult> {
  // Cast TS uniquement, aucune conséquence RLS (déterminée par le JWT du client, jamais par son
  // typage) — même friction connue et documentée que embedded-link-write.ts.
  const rlsClient = ctx.supabase as unknown as ReturnType<typeof createSupabaseAdminClient>;

  // Rôle ET tenant lus ICI, indépendamment de tout appelant (`requireRole('owner')` côté action
  // 'use server' refuse déjà un non-owner avant d'atteindre ce module, mais cette fonction reste
  // testable/appelable hors de ce wrapper — reproduit la règle plutôt que de la tenir pour acquise,
  // même discipline que embedded-link-write.ts et que `requireRole` lui-même
  // (lib/actions/safe-action.ts). Un utilisateur n'appartient qu'à un seul tenant
  // (`enforce_single_organization_membership`) : pas de filtre merchant_account_id nécessaire ici.
  const { data: membership, error: membershipError } = await rlsClient
    .from('merchant_member')
    .select('id, merchant_account_id, role')
    .eq('user_id', ctx.userId)
    .limit(1)
    .maybeSingle();

  if (membershipError || !membership) {
    return { ok: false, errorCode: 'not_a_member' };
  }

  const merchantAccountId = membership.merchant_account_id;

  const { data: shop, error: shopError } = await rlsClient
    .from('shop')
    .select(
      'id, merchant_account_id, status, shopify_client_id, access_token_encrypted, refresh_token_encrypted',
    )
    .eq('id', input.shopId)
    .eq('merchant_account_id', merchantAccountId)
    .maybeSingle();

  if (shopError) {
    return { ok: false, errorCode: 'write_failed' };
  }

  const { data: connection, error: connectionError } = shop
    ? await rlsClient
        .from('store_connection')
        .select('id, status, platform_app_id')
        .eq('shop_id', shop.id)
        .maybeSingle()
    : { data: null, error: null };

  if (connectionError) {
    return { ok: false, errorCode: 'write_failed' };
  }

  const decision = decideAppRelease({
    requestingRole: membership.role,
    requestingMerchantAccountId: merchantAccountId,
    shop: shop
      ? {
          merchantAccountId: shop.merchant_account_id,
          status: shop.status,
          shopifyClientId: shop.shopify_client_id,
          accessTokenEncrypted: shop.access_token_encrypted,
          refreshTokenEncrypted: shop.refresh_token_encrypted,
        }
      : null,
    connection: connection
      ? { status: connection.status, platformAppId: connection.platform_app_id }
      : null,
  });

  if (decision.kind === 'refuse') {
    // Refus après identification : trace durable, jamais seulement Sentry — le mandat exige acteur,
    // tenant, boutique, ancienne app ET raison de refus dans l'audit durable existant.
    if (shop) {
      const admin = createSupabaseAdminClient();
      await admin.from('audit_log').insert({
        merchant_account_id: merchantAccountId,
        actor_user_id: ctx.userId,
        action: 'shopify.app_release_refused',
        resource_type: 'shop',
        resource_id: shop.id,
        reason: decision.reason,
        payload: { oldClientId: shop.shopify_client_id },
      });
    } else {
      Sentry.captureMessage('shopify_app_release_refused_no_shop', {
        level: 'warning',
        tags: { action: 'shopify.app_release', reason: decision.reason },
      });
    }
    return { ok: false, errorCode: decision.reason };
  }

  // decision.kind === 'ok' — shop et connection sont non-null ici (le seul chemin qui atteint
  // 'ok' dans decideAppRelease exige les deux).
  const oldClientId = shop?.shopify_client_id as string;
  const admin = createSupabaseAdminClient();

  // 1. Intention, avant toute mutation.
  const { error: attemptAuditError } = await admin.from('audit_log').insert({
    merchant_account_id: merchantAccountId,
    actor_user_id: ctx.userId,
    action: 'shopify.app_release_attempted',
    resource_type: 'shop',
    resource_id: shop?.id,
    payload: { oldClientId },
  });

  if (attemptAuditError) {
    Sentry.captureException(attemptAuditError, {
      tags: { action: 'shopify.app_release', reason: 'attempt_audit_failed' },
    });
    return { ok: false, errorCode: 'write_failed' };
  }

  // 2. store_connection : platform_app_id -> NULL, compare-and-set sur les valeurs déjà validées
  // (garde d'intégrité — ne nulle jamais une connexion dont l'état a dévié entre temps de lecture
  // et d'écriture ; le predicate `platform_app_id` accepte les deux valeurs possibles — ancienne
  // app OU déjà NULL — pour ne jamais bloquer une reprise idempotente). L'EXCLUSIVITÉ entre deux
  // appels concurrents n'est PAS garantie ici (deux écritures concurrentes identiques, même
  // valeur cible, ne se bloquent pas mutuellement) — elle l'est à l'étape 3 ci-dessous, sur le
  // compare-and-set `shopify_client_id = <ancienne app>` : un seul appelant peut encore satisfaire
  // ce predicate une fois que l'autre a déjà mis `shop.shopify_client_id` à NULL en premier.
  let connectionUpdateQuery = admin
    .from('store_connection')
    .update({ platform_app_id: null })
    .eq('shop_id', shop?.id as string)
    .eq('merchant_account_id', merchantAccountId)
    .eq('status', 'uninstalled');
  connectionUpdateQuery =
    connection?.platform_app_id === null
      ? connectionUpdateQuery.is('platform_app_id', null)
      : connectionUpdateQuery.eq('platform_app_id', oldClientId);

  const { data: updatedConnection, error: connectionUpdateError } = await connectionUpdateQuery
    .select('id')
    .maybeSingle();

  if (connectionUpdateError || !updatedConnection) {
    Sentry.captureException(
      connectionUpdateError ?? new Error('shopify_app_release_connection_update_no_row'),
      { tags: { action: 'shopify.app_release', reason: 'connection_update_failed' } },
    );
    return { ok: false, errorCode: 'write_failed' };
  }

  // Révocation du jeton opaque, si une ligne existe et n'est pas déjà révoquée — mesuré au
  // préalable (`processAppUninstalledCore` ne le fait pas) : c'est ici que cette révocation a
  // réellement lieu pour la première fois dans ce dépôt.
  const { error: tokenRevokeError } = await admin
    .from('store_connection_webhook_token')
    .update({ revoked_at: new Date().toISOString() })
    .eq('store_connection_id', updatedConnection.id)
    .is('revoked_at', null);

  if (tokenRevokeError) {
    Sentry.captureException(tokenRevokeError, {
      tags: { action: 'shopify.app_release', reason: 'token_revoke_failed' },
    });
    return { ok: false, errorCode: 'write_failed' };
  }

  // 3. shop.shopify_client_id -> NULL, EN DERNIER. Client RLS (policy shop_update le permet pour
  // owner/manager ; la garde applicative ci-dessus est déjà plus stricte, owner seul).
  const { data: updatedShop, error: shopUpdateError } = await rlsClient
    .from('shop')
    .update({ shopify_client_id: null, updated_at: new Date().toISOString() })
    .eq('id', shop?.id as string)
    .eq('merchant_account_id', merchantAccountId)
    .eq('status', 'uninstalled')
    .eq('shopify_client_id', oldClientId)
    .select('id')
    .maybeSingle();

  if (shopUpdateError || !updatedShop) {
    Sentry.captureException(
      shopUpdateError ?? new Error('shopify_app_release_shop_update_no_row'),
      {
        tags: { action: 'shopify.app_release', reason: 'shop_update_failed' },
      },
    );
    return { ok: false, errorCode: 'write_failed' };
  }

  // 4. Résultat, seulement une fois les deux mutations confirmées.
  await admin.from('audit_log').insert({
    merchant_account_id: merchantAccountId,
    actor_user_id: ctx.userId,
    action: 'shopify.app_released',
    resource_type: 'shop',
    resource_id: shop?.id,
    payload: { oldClientId },
  });

  return { ok: true };
}
