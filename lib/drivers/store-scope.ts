/**
 * Portée boutique des livreurs (migration 0133).
 *
 * Un livreur reste une entité du LOCATAIRE : son identité, son cash consolidé et
 * son stock en main sont indivisibles et se calculent sur l'ensemble de ses
 * mouvements, toutes boutiques confondues. Ce qui est scopé par boutique, c'est
 * sa VISIBILITÉ dans `/livreurs` et son ÉLIGIBILITÉ à recevoir une affectation.
 *
 * L'appartenance est N-N (`driver_shop`) et non une colonne sur `driver`, parce
 * qu'un livreur de production sert réellement deux boutiques — cf. l'en-tête de
 * 0133 pour la mesure.
 *
 * Ce module ne fait AUCUN filtrage côté React : les identifiants retournés ici
 * bornent la requête serveur elle-même.
 */
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

type Client = SupabaseClient<Database>;

/**
 * Identifiants des livreurs rattachés à une boutique.
 *
 * Volume borné par nature : un parc de livreurs se compte en dizaines (6 sur
 * l'ensemble de la base de production au moment de 0133). Le `.in(...)` que les
 * appelants construisent ensuite reste donc très loin de la limite d'URL
 * PostgREST — à réévaluer seulement si un locataire approchait le millier.
 */
export async function getStoreDriverIds(
  supabase: Client,
  merchantAccountId: string,
  shopId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from('driver_shop')
    .select('driver_id')
    .eq('merchant_account_id', merchantAccountId)
    .eq('shop_id', shopId);

  if (error || !data) {
    return [];
  }

  return [...new Set(data.map((row) => row.driver_id))];
}

/**
 * Sentinelle pour un `.in(...)` sur une liste vide.
 *
 * PostgREST traite `in.()` comme une erreur de syntaxe, et omettre le filtre
 * ramènerait TOUS les livreurs du locataire — exactement la fuite que ce module
 * existe pour fermer. Un UUID impossible garantit un résultat vide.
 */
export const NO_DRIVER_SENTINEL = '00000000-0000-0000-0000-000000000000';

export function driverIdFilter(driverIds: string[]): string[] {
  return driverIds.length > 0 ? driverIds : [NO_DRIVER_SENTINEL];
}
