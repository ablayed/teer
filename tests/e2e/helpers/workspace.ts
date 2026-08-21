import type { Locator, Page } from '@playwright/test';
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

/**
 * Rattache un livreur à une boutique (migration 0133).
 *
 * Depuis 0133, `/livreurs` et le sélecteur d'affectation lisent `driver_shop`,
 * pas `driver` seule : un livreur inséré directement par une fixture, SANS
 * rattachement, n'apparaît donc plus nulle part — écran vide, aucune erreur.
 * Même classe de piège que les seeds qui écrivent l'état d'une commande sans
 * passer par `transition_order` et ne peuplent jamais `order_state_transition`.
 *
 * Sans `shopId`, on rattache à la boutique par défaut, ce qui correspond au cas
 * mono-boutique de la quasi-totalité des fixtures.
 */
export async function attachDriverToStore(
  admin: SupabaseClient,
  merchantAccountId: string,
  driverId: string,
  shopId?: string,
): Promise<void> {
  const targetShopId = shopId ?? (await defaultShopId(admin, merchantAccountId));
  const { error } = await admin.from('driver_shop').insert({
    driver_id: driverId,
    merchant_account_id: merchantAccountId,
    shop_id: targetShopId,
  });
  if (error && !error.message.includes('duplicate')) {
    throw error;
  }
}

/**
 * Rend le contexte de boutique visible, sur desktop comme sur mobile.
 *
 * Deux pièges combinés :
 *
 *  1. Le composant est monté DEUX fois (barre latérale + menu mobile), l'une des
 *     copies étant masquée selon le viewport. Un `getByText(...).first()` résout
 *     la copie de la barre latérale — masquée sur mobile — et échoue en
 *     « hidden » pour une raison sans rapport avec le comportement testé. D'où
 *     le ciblage `:visible`.
 *  2. Sur mobile, le contrôle vit dans le menu « Plus ». Après une NAVIGATION
 *     DOCUMENT complète (ce que fait le changement de boutique), le bouton est
 *     présent dans le HTML avant que React ne soit hydraté : un premier clic peut
 *     donc ne rien déclencher. On retente au lieu d'attendre un délai fixe.
 */
export async function revealStoreContext(page: Page): Promise<Locator> {
  const visibleName = page.locator('[data-testid="store-switcher-name"]:visible').first();

  if ((page.viewportSize()?.width ?? 1280) >= 768) {
    return visibleName;
  }

  const plus = page.getByRole('button', { name: 'Plus' });
  await plus.waitFor({ state: 'visible', timeout: 30_000 });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await plus.click();
    try {
      await visibleName.waitFor({ state: 'visible', timeout: 3_000 });
      return visibleName;
    } catch {
      // Clic absorbé avant hydratation : on réessaie.
    }
  }

  return visibleName;
}
