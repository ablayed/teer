// Phase 2 / Lot L2 — couche applicative : résolution + recoupement d'app d'une connexion.
//
// C'est ICI, et nulle part dans un adaptateur, que vivent : la lecture de `store_connection`, le
// recoupement `platform_app_id`, et la production du seul type habilité à représenter un contexte
// résolu (ResolvedConnectionContext, lib/ingestion/canonical.ts). Un événement dont le HMAC est
// validé par l'app A mais dont la store_connection trouvée porte le platform_app_id de l'app B est
// refusé ICI, avant toute écriture — jamais après.
import type {
  ResolveConnectionResult,
  ResolvedConnectionContext,
  VerifiedWebhook,
} from '@/lib/ingestion/canonical';
import { parseWebhookToken, verifyWebhookTokenSecret } from '@/lib/ingestion/webhook-token';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

type AdminClient = SupabaseClient<Database>;
// store_connection_webhook_token (migration 0143) n'est pas encore dans database.types.ts tant que
// 0143 n'est pas confirmée en production (règle #3, CLAUDE.md) — même motif que
// tests/rls/l1-canonical-ingestion-schema.rls.test.ts pour 0142 : un client non typé, réservé aux
// seuls appels touchant cette table.
type RawAdminClient = SupabaseClient;

// Cette fonction est le SEUL endroit du dépôt habilité à produire une valeur de type
// ResolvedConnectionContext : le brand nominal (symbole privé de lib/ingestion/canonical.ts) rend
// toute construction littérale ailleurs impossible à la compilation — un `as unknown as
// ResolvedConnectionContext` explicite est la seule échappatoire, et il n'existe qu'ici. C'est la
// preuve de typage exigée par le lot (#4) : un identifiant brut ne peut jamais compiler là où un
// contexte résolu est attendu, sauf en passant par ce module.
export async function resolveConnectionForWebhook(
  supabase: AdminClient,
  verified: VerifiedWebhook,
  { platform }: { platform: string },
): Promise<ResolveConnectionResult> {
  const { data, error } = await supabase
    .from('store_connection')
    .select('id, merchant_account_id, shop_id, platform, platform_app_id, status')
    .eq('platform', platform)
    .eq('external_identifier', verified.externalConnectionId)
    .maybeSingle();

  if (error || !data) {
    return { ok: false, reason: 'unknown_connection' };
  }

  // Recoupement obligatoire : l'app qui a validé le HMAC doit correspondre au platform_app_id de
  // la connexion trouvée. Une connexion sans platform_app_id enregistré (jamais backfillée avec un
  // client_id connu) ne peut jamais être recoupée avec confiance → refus, jamais un laissez-passer.
  if (!data.platform_app_id || data.platform_app_id !== verified.platformAppId) {
    return { ok: false, reason: 'app_mismatch' };
  }

  return {
    ok: true,
    context: {
      storeConnectionId: data.id,
      merchantAccountId: data.merchant_account_id,
      shopId: data.shop_id,
      platform: data.platform,
      platformAppId: data.platform_app_id,
    } as unknown as import('@/lib/ingestion/canonical').ResolvedConnectionContext,
  };
}

// ============================================================================
// Phase 2 / Lot L3 (périmètre réduit) — résolution par jeton d'URL opaque.
// ============================================================================
// Ordre d'autorité : URL (jeton) → connexion → platform_app_id → HMAC du corps → comparaison de
// l'en-tête. `resolveConnectionByToken` couvre la PREMIÈRE étape (URL → connexion), en s'appuyant
// UNIQUEMENT sur les matériaux du jeton — jamais un en-tête, jamais le corps. `finalizeResolvedConnection`
// couvre la 3ᵉ (platform_app_id → recoupement), une fois que l'appelant a lui-même identifié quelle
// app a validé le HMAC (2ᵉ étape, hors de ce module — cf. lib/shopify/adapter.ts `identifyValidatingApps`).

export type TokenIdentifiedConnection = {
  readonly storeConnectionId: string;
  readonly merchantAccountId: string;
  readonly shopId: string;
  readonly platform: string;
  readonly platformAppId: string | null;
  readonly externalIdentifier: string;
};

// Six causes distinctes en interne — JAMAIS exposées telles quelles à l'appelant HTTP, qui doit
// répondre de façon indifférenciée (preuve #4 du lot). `app_mismatch` (ConnectionRefusalReason,
// export existant) est une 7ᵉ cause distincte, à un autre étage (finalizeResolvedConnection).
export type TokenRefusalReason =
  | 'malformed_token'
  | 'unknown_token'
  | 'revoked'
  | 'secret_expired'
  | 'secret_mismatch'
  | 'connection_inactive';

export type ResolveConnectionByTokenResult =
  | { ok: true; connection: TokenIdentifiedConnection }
  | { ok: false; reason: TokenRefusalReason };

type StoreConnectionWebhookTokenRow = {
  secret_hash: string;
  previous_secret_hash: string | null;
  previous_secret_expires_at: string | null;
  revoked_at: string | null;
  store_connection_id: string;
};

// Résout la connexion à partir du seul jeton présent dans l'URL — aucune lecture d'en-tête, aucune
// lecture de corps. `supabase` reste le client admin typé habituel ; l'accès à la table non encore
// typée (0143, pas confirmée en prod) passe par un cast localisé, seul endroit de ce fichier qui en
// a besoin.
export async function resolveConnectionByToken(
  supabase: AdminClient,
  rawToken: string,
): Promise<ResolveConnectionByTokenResult> {
  const parsed = parseWebhookToken(rawToken);

  if (!parsed) {
    return { ok: false, reason: 'malformed_token' };
  }

  const rawSupabase = supabase as unknown as RawAdminClient;
  const { data: tokenRow, error: tokenError } = await rawSupabase
    .from('store_connection_webhook_token')
    .select(
      'secret_hash, previous_secret_hash, previous_secret_expires_at, revoked_at, store_connection_id',
    )
    .eq('public_id', parsed.publicId)
    .maybeSingle();

  if (tokenError || !tokenRow) {
    return { ok: false, reason: 'unknown_token' };
  }

  const row = tokenRow as StoreConnectionWebhookTokenRow;

  if (row.revoked_at) {
    return { ok: false, reason: 'revoked' };
  }

  const matchesCurrent = verifyWebhookTokenSecret(parsed.secret, row.secret_hash);

  if (!matchesCurrent) {
    const matchesPrevious =
      Boolean(row.previous_secret_hash) &&
      verifyWebhookTokenSecret(parsed.secret, row.previous_secret_hash as string);

    if (!matchesPrevious) {
      return { ok: false, reason: 'secret_mismatch' };
    }

    const graceStillOpen =
      Boolean(row.previous_secret_expires_at) &&
      new Date(row.previous_secret_expires_at as string).getTime() > Date.now();

    if (!graceStillOpen) {
      return { ok: false, reason: 'secret_expired' };
    }
  }

  const { data: connection, error: connectionError } = await supabase
    .from('store_connection')
    .select(
      'id, merchant_account_id, shop_id, platform, platform_app_id, external_identifier, status',
    )
    .eq('id', row.store_connection_id)
    .maybeSingle();

  if (connectionError || !connection) {
    return { ok: false, reason: 'unknown_token' };
  }

  if (connection.status !== 'active') {
    return { ok: false, reason: 'connection_inactive' };
  }

  return {
    ok: true,
    connection: {
      storeConnectionId: connection.id,
      merchantAccountId: connection.merchant_account_id,
      shopId: connection.shop_id,
      platform: connection.platform,
      platformAppId: connection.platform_app_id,
      externalIdentifier: connection.external_identifier,
    },
  };
}

// Recoupement final : la connexion identifiée par le jeton doit porter le platform_app_id de l'app
// qui a effectivement validé le HMAC. Même comparaison, même raison de refus (`app_mismatch`) que
// `resolveConnectionForWebhook` — c'est le même contrôle, appliqué à une connexion déjà résolue par
// jeton plutôt que par (platform, external_identifier). Seul module habilité à produire la seconde
// forme de ResolvedConnectionContext.
export function finalizeResolvedConnection(
  connection: TokenIdentifiedConnection,
  verifiedApp: { readonly clientId: string },
): ResolveConnectionResult {
  if (!connection.platformAppId || connection.platformAppId !== verifiedApp.clientId) {
    return { ok: false, reason: 'app_mismatch' };
  }

  return {
    ok: true,
    context: {
      storeConnectionId: connection.storeConnectionId,
      merchantAccountId: connection.merchantAccountId,
      shopId: connection.shopId,
      platform: connection.platform,
      platformAppId: connection.platformAppId,
    } as unknown as ResolvedConnectionContext,
  };
}
