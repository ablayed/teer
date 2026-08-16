import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Identifiant de la boutique ACTIVE d'une organisation de test.
 *
 * Depuis la migration 0126, `handle_new_user` provisionne systématiquement une
 * boutique manuelle marquée `is_default` à la création de l'organisation. Une
 * session qui se connecte sur une route legacy (/commandes, /produits, …)
 * atterrit sur CETTE boutique, et toutes les lectures sont scopées à elle.
 *
 * Conséquence pour les fixtures : créer une boutique supplémentaire puis y
 * semer les données produit une organisation multi-boutiques dont l'écran
 * observé est VIDE — sans erreur, juste des compteurs à zéro et des lignes
 * absentes. Les fixtures doivent donc semer dans la boutique retournée ici, ou
 * naviguer explicitement vers /s/{id}/… pour la boutique qu'elles ciblent.
 */
export async function defaultShopId(
  admin: SupabaseClient,
  merchantAccountId: string,
): Promise<string> {
  const { data, error } = await admin
    .from('shop')
    .select('id, is_default')
    .eq('merchant_account_id', merchantAccountId)
    .order('is_default', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) {
    throw error ?? new Error('Boutique par défaut introuvable pour cette organisation');
  }

  return data.id as string;
}
