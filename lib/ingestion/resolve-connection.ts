// Phase 2 / Lot L2 — couche applicative : résolution + recoupement d'app d'une connexion.
//
// C'est ICI, et nulle part dans un adaptateur, que vivent : la lecture de `store_connection`, le
// recoupement `platform_app_id`, et la production du seul type habilité à représenter un contexte
// résolu (ResolvedConnectionContext, lib/ingestion/canonical.ts). Un événement dont le HMAC est
// validé par l'app A mais dont la store_connection trouvée porte le platform_app_id de l'app B est
// refusé ICI, avant toute écriture — jamais après.
import type { ResolveConnectionResult, VerifiedWebhook } from '@/lib/ingestion/canonical';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

type AdminClient = SupabaseClient<Database>;

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
