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
// sur le chemin d'écriture réel.
//
// Cache ASYMÉTRIQUE, volontairement : un résultat NÉGATIF (colonnes absentes) est mis en cache à
// vie par instance de client (WeakSet) — sûr, car ce projet applique les migrations en append-only
// (jamais de colonne réintroduite après un `drop`, cf. CLAUDE.md). Un résultat POSITIF (colonnes
// présentes) N'EST JAMAIS mis en cache — chaque appel resonde. Un même client PEUT parler à deux
// schémas différents pendant sa propre durée de vie : preuve live (S3-A3-R, scratch test exécuté
// et supprimé) qu'un client réutilisé sur plusieurs opérations (boucle bulk/cron, `admin` unique
// partagé par `for (const shop of shops)` dans `app/api/cron/shopify-reconcile/route.ts`, puis par
// `for (const node of nodes)` dans `persistBulkOrders`) peut sonder `true` avant que 0120 ne
// s'applique en prod PENDANT l'exécution de cette même boucle, sans jamais être recréé. Mettre ce
// `true` en cache aurait fait échouer irrémédiablement la première commande post-0120 traitée par
// CE client, avec une erreur `column does not exist` remontant du chemin métier — pas seulement le
// temps d'une requête suivante sur un client neuf. Le coût de ne jamais cacher le positif est une
// sonde `limit(0)` supplémentaire par opération, uniquement TANT QUE le schéma est encore pré-0120
// (donc borné dans le temps par la durée de vie de ce bridge, pas permanent) ; dès que 0120 est
// constaté, plus aucune sonde n'est jamais refaite pour ce client.

import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

type AdminClient = SupabaseClient<Database>;

const knownUnavailable = new WeakSet<AdminClient>();

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

export async function getCustomerPcdColumnsAvailable(admin: AdminClient): Promise<boolean> {
  if (knownUnavailable.has(admin)) {
    return false;
  }

  const available = await probeCustomerPcdColumnsAvailable(admin);

  if (!available) {
    knownUnavailable.add(admin);
  }

  return available;
}
