// SHOPIFY-EXPIRING-TOKENS-01 — bail de jeton Shopify par domaine, côté applicatif.
//
// Shopify exige de SÉRIALISER, par boutique, l'échange de code, l'échange par ID token et le
// rafraîchissement : « Acquiring a token and refreshing one each retire the other's result. »
// Le schéma (0158, 0159) fournit le bail et les écritures fencées ; ce module est le SEUL endroit
// applicatif qui les appelle pour les trois opérations d'acquisition. Les primitives destructives
// de 0159 (désinstallation, déconnexion, libération d'identité) prennent le bail elles-mêmes, en
// préemption, dans leur propre transaction : elles ne passent pas par `acquireShopifyTokenLease`.
//
// Cycle d'une opération sous bail :
//   1. acquisition (`acquire_shopify_token_lease`) — AVANT tout appel réseau Shopify : un bail
//      tenu par un autre détenteur arrête l'opération ici, sans appel sortant ;
//   2. appel Shopify, borné par SHOPIFY_TOKEN_REQUEST_TIMEOUT_MS (lib/shopify/oauth.ts) ;
//   3. écriture fencée (`persist_shopify_credentials_fenced`), puis `store_connection`
//      (`write_shopify_store_connection_fenced`) en transaction distincte ;
//   4. libération par UPDATE conditionnel, toujours tentée (finally).
//
// Pur de toute dépendance d'environnement (ni lib/env, ni registre d'apps) : importable par les
// suites RLS sans `RESEND_API_KEY`.
import type { Database } from '@/lib/supabase/database.types';
import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

type AdminClient = SupabaseClient<Database>;

// TTL du bail (SHOPIFY-EXPIRING-TOKENS-01 §9). L'opération la plus longue sous bail est UN appel
// au endpoint de jeton (borné à 20 s, lib/shopify/oauth.ts) suivi d'au plus trois appels RPC.
// 60 s laisse une marge d'un facteur 3 sur la borne réseau, sans renouvellement. Il borne aussi
// l'attente d'une réinstallation concurrente d'une désinstallation (§4.1 point 4). Un
// dépassement n'est jamais une corruption : l'écriture est fencée par la génération, et
// l'expiration seule ne fence pas — seule une REPRISE périme l'ancien détenteur.
export const SHOPIFY_TOKEN_LEASE_TTL_SECONDS = 60;

// Forme canonique exigée par le schéma (0158) : un domaine non canonique n'a pas de bail.
const CANONICAL_SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function isLeaseableShopDomain(shopDomain: string): boolean {
  return CANONICAL_SHOP_DOMAIN.test(shopDomain);
}

export type ShopifyTokenLeaseOperation =
  | 'authorization_code'
  | 'token_exchange'
  | 'refresh'
  | 'embedded_link'
  | 'uninstall_connection_resume';

export type ShopifyTokenLeaseAcquisition =
  | { ok: true; generation: number }
  | { ok: false; reason: 'lease_held' | 'lease_error' };

// Refus d'acquisition : sentinelle distincte de `lease_lost`. Le bail est tenu, l'opération n'a
// rien fait, et c'est normal sous concurrence.
export function reportShopifyTokenLeaseBusy(operation: ShopifyTokenLeaseOperation): void {
  Sentry.captureMessage('shopify_token_lease_busy', {
    level: 'info',
    tags: { module: 'shopify.token-lease', operation },
  });
}

// Bail perdu PENDANT l'opération : un autre détenteur l'a repris. L'appel Shopify a peut-être eu
// lieu, et son résultat n'a pas été écrit. Refus nommé, jamais une erreur technique.
export function reportShopifyTokenLeaseLost(operation: ShopifyTokenLeaseOperation): void {
  Sentry.captureMessage('shopify_token_lease_lost', {
    level: 'warning',
    tags: { module: 'shopify.token-lease', operation },
  });
}

export async function acquireShopifyTokenLease(
  admin: AdminClient,
  shopDomain: string,
): Promise<ShopifyTokenLeaseAcquisition> {
  const { data, error } = await admin.rpc('acquire_shopify_token_lease', {
    p_shop_domain: shopDomain,
    p_ttl_seconds: SHOPIFY_TOKEN_LEASE_TTL_SECONDS,
  });

  if (error) {
    Sentry.captureException(new Error('shopify_token_lease_acquire_failed'), {
      tags: { module: 'shopify.token-lease' },
      extra: { code: error.code },
    });
    return { ok: false, reason: 'lease_error' };
  }

  const row = data?.[0];
  if (!row) {
    return { ok: false, reason: 'lease_held' };
  }

  return { ok: true, generation: row.acquired_generation };
}

// Libération conditionnelle : seul le détenteur de la génération courante libère. Zéro ligne
// (bail repris entre-temps) n'est pas une erreur. Un échec laisse le bail expirer au TTL.
export async function releaseShopifyTokenLease(
  admin: AdminClient,
  shopDomain: string,
  generation: number,
): Promise<void> {
  const { error } = await admin
    .from('shopify_token_lease')
    .update({ lease_expires_at: null })
    .eq('shop_domain', shopDomain)
    .eq('generation', generation)
    .not('lease_expires_at', 'is', null);

  if (error) {
    Sentry.captureException(new Error('shopify_token_lease_release_failed'), {
      tags: { module: 'shopify.token-lease' },
      extra: { code: error.code },
    });
  }
}

export type PersistShopifyCredentialsFencedInput = {
  mode: 'authorization_code' | 'token_exchange' | 'refresh';
  shopDomain: string;
  generation: number;
  merchantAccountId: string;
  clientId: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string | null;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  scopes: string | null;
};

export type PersistShopifyCredentialsOutcome =
  | 'inserted'
  | 'updated'
  | 'lease_lost'
  | 'ownership_refused'
  | 'app_switch_refused'
  | 'app_identity_mismatch'
  | 'shop_not_found'
  | 'shop_inactive'
  | 'invalid_input'
  | 'write_failed'
  | 'rpc_error';

// Les quatre valeurs de jeton (access, refresh, et leurs deux échéances) sont persistées en UNE
// seule instruction SQL, dans la RPC, pour les trois modes.
export async function persistShopifyCredentialsFenced(
  admin: AdminClient,
  input: PersistShopifyCredentialsFencedInput,
): Promise<{ outcome: PersistShopifyCredentialsOutcome; shopId: string | null }> {
  const { data, error } = await admin.rpc('persist_shopify_credentials_fenced', {
    p_mode: input.mode,
    p_shop_domain: input.shopDomain,
    p_generation: input.generation,
    p_merchant_account_id: input.merchantAccountId,
    p_client_id: input.clientId,
    p_access_token_encrypted: input.accessTokenEncrypted,
    // Les types générés ne portent pas la nullabilité des arguments SQL : NULL est accepté par la
    // RPC (conservation de la valeur en place en mode refresh, 0158).
    p_refresh_token_encrypted: input.refreshTokenEncrypted as string,
    p_access_token_expires_at: input.accessTokenExpiresAt as string,
    p_refresh_token_expires_at: input.refreshTokenExpiresAt as string,
    p_scopes: input.scopes as string,
  });

  if (error) {
    Sentry.captureException(new Error('shopify_credentials_fenced_rpc_failed'), {
      tags: { module: 'shopify.token-lease', mode: input.mode },
      extra: { code: error.code },
    });
    return { outcome: 'rpc_error', shopId: null };
  }

  const row = data?.[0];
  return {
    outcome: (row?.outcome ?? 'write_failed') as PersistShopifyCredentialsOutcome,
    shopId: row?.shop_id ?? null,
  };
}

export type ShopifyStoreConnectionFencedOutcome =
  | 'written'
  | 'lease_lost'
  | 'shop_not_found'
  | 'ownership_refused'
  | 'app_identity_mismatch'
  | 'invalid_input'
  | 'rpc_error';

// Transaction DISTINCTE de la persistance des credentials : son échec ne défait jamais des
// credentials déjà écrits (best-effort voulu, même discipline qu'avant ce lot).
export async function writeShopifyStoreConnectionFenced(
  admin: AdminClient,
  input: { shopDomain: string; generation: number; merchantAccountId: string; clientId: string },
): Promise<ShopifyStoreConnectionFencedOutcome> {
  const { data, error } = await admin.rpc('write_shopify_store_connection_fenced', {
    p_shop_domain: input.shopDomain,
    p_generation: input.generation,
    p_merchant_account_id: input.merchantAccountId,
    p_client_id: input.clientId,
  });

  if (error) {
    return 'rpc_error';
  }

  return (data?.[0]?.outcome ?? 'rpc_error') as ShopifyStoreConnectionFencedOutcome;
}

export type ShopifyStoreConnectionUninstallOutcome =
  | 'written'
  | 'lease_lost'
  | 'connection_not_found'
  | 'ownership_refused'
  | 'invalid_input'
  | 'rpc_error';

// Passage fencé de `store_connection` à `uninstalled`, sous la génération obtenue par la
// primitive destructive (ou par une acquisition normale, cf. markShopifyConnectionUninstalled).
export async function markShopifyStoreConnectionUninstalledFenced(
  admin: AdminClient,
  input: { shopDomain: string; generation: number; merchantAccountId: string },
): Promise<ShopifyStoreConnectionUninstallOutcome> {
  const { data, error } = await admin.rpc('mark_shopify_store_connection_uninstalled_fenced', {
    p_shop_domain: input.shopDomain,
    p_generation: input.generation,
    p_merchant_account_id: input.merchantAccountId,
  });

  if (error) {
    return 'rpc_error';
  }

  return (data?.[0]?.outcome ?? 'rpc_error') as ShopifyStoreConnectionUninstallOutcome;
}

// Passage de `store_connection` à `uninstalled` APRÈS une primitive destructive de 0159.
//   - génération rendue par la primitive (préemption réussie) : écriture sous cette génération,
//     puis libération ;
//   - génération NULL avec un domaine canonique (verdict idempotent, ex. `already_uninstalled`,
//     qui ne prend pas le bail) : la reprise acquiert un bail NORMAL avant d'écrire (§4.1 point 1).
//     Bail tenu par un autre : rien n'est écrit ; le prochain événement reprendra ;
//   - domaine non canonique : hors bail, rien à écrire ici — aucune connexion Shopify fencée
//     n'existe pour ces domaines.
export async function markShopifyConnectionUninstalled(
  admin: AdminClient,
  input: { shopDomain: string; generation: number | null; merchantAccountId: string },
): Promise<ShopifyStoreConnectionUninstallOutcome | 'lease_held' | 'not_leaseable'> {
  if (!isLeaseableShopDomain(input.shopDomain)) {
    return 'not_leaseable';
  }

  let generation = input.generation;
  if (generation === null) {
    const lease = await acquireShopifyTokenLease(admin, input.shopDomain);
    if (!lease.ok) {
      if (lease.reason === 'lease_held') {
        reportShopifyTokenLeaseBusy('uninstall_connection_resume');
        return 'lease_held';
      }
      return 'rpc_error';
    }
    generation = lease.generation;
  }

  try {
    const outcome = await markShopifyStoreConnectionUninstalledFenced(admin, {
      shopDomain: input.shopDomain,
      generation,
      merchantAccountId: input.merchantAccountId,
    });
    if (outcome === 'lease_lost') {
      reportShopifyTokenLeaseLost('uninstall_connection_resume');
    }
    return outcome;
  } finally {
    await releaseShopifyTokenLease(admin, input.shopDomain, generation);
  }
}
