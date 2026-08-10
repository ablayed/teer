// Bridge S3-A3 (dual-schema 0120) — migration 0120 supprime 5 colonnes PCD de `customer`
// (tags, accepts_marketing, shopify_orders_count, shopify_amount_spent_minor, first_seen_at).
// Tant que le code doit fonctionner AVANT et APRÈS cette migration, aucun appelant ne peut les
// référencer inconditionnellement dans un select/insert/update PostgREST : la moindre colonne
// absente du schema cache fait échouer TOUT le select/update (PGRST204 / 42703), pas seulement
// la valeur manquante — ce qui casserait silencieusement la fiche client et le RGPD post-0120
// s'ils continuaient à référencer ces colonnes sans condition.
//
// Détection par capability (une lecture bornée `limit(0)` sur la colonne représentative `tags`,
// les 5 colonnes étant supprimées ensemble dans la même migration), jamais par tentative/erreur
// sur le chemin d'écriture réel. Le résultat est mis en cache par instance de client (WeakMap) :
// un même client ne parle qu'à UN SEUL schéma pendant sa durée de vie, donc une seule détection
// suffit ; des clients distincts (tests contre des états de schéma différents) ne partagent jamais
// le cache.

import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

type AdminClient = SupabaseClient<Database>;

const availabilityCache = new WeakMap<AdminClient, Promise<boolean>>();

// Codes Postgres/PostgREST correspondant EXACTEMENT à "colonne absente du schéma" —
// l'incompatibilité précise que 0120 introduit. Toute autre erreur doit remonter.
const MISSING_COLUMN_ERROR_CODES = new Set(['42703', 'PGRST204']);

async function probeCustomerPcdColumnsAvailable(admin: AdminClient): Promise<boolean> {
  const { error } = await admin.from('customer').select('tags').limit(0);

  if (!error) {
    return true;
  }

  if (MISSING_COLUMN_ERROR_CODES.has(error.code ?? '')) {
    return false;
  }

  throw error;
}

export function getCustomerPcdColumnsAvailable(admin: AdminClient): Promise<boolean> {
  const cached = availabilityCache.get(admin);
  if (cached) {
    return cached;
  }

  const probe = probeCustomerPcdColumnsAvailable(admin);
  availabilityCache.set(admin, probe);
  return probe;
}
