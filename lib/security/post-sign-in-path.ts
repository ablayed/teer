import { safeRedirectPath } from '@/lib/security/safe-redirect';
import { SHOPIFY_SHOPS_ARRIVAL_PATH } from '@/lib/shopify/arrival';

/**
 * Destination après une connexion réussie : TOUJOURS le point d'entrée workspace (`/s`).
 *
 * Rediriger directement vers `/tableau` (ou vers la section demandée) faisait entrer un
 * utilisateur multi-boutiques dans sa boutique par DÉFAUT sans qu'il ait choisi. `/s` tranche :
 * entrée automatique s'il n'a qu'une boutique, choix explicite au-delà.
 *
 * Exception nommée et étroite (APP-03 / Lot 2) : le rattachement Shopify embarqué connaît déjà
 * sa boutique cible (portée par la continuation signée dans la query) — le sélecteur /s
 * proposerait un choix hors-sujet (choisir un workspace existant plutôt que rattacher une
 * boutique neuve). Seul ce préfixe exact est exempté ; cette fonction reste l'entrée workspace
 * pour tout le reste, y compris tout autre chemin sous /shopify/.
 *
 * Seconde exception, aussi étroite (SHOPIFY-OAUTH-FIRST-01 / R1) : l'arrivée d'une boutique
 * Shopify déjà installée reprend sur `/parametres?tab=shops` — ce chemin EXACT, avec cette seule
 * chaîne de requête. Toute variante (autre paramètre, autre onglet) repasse par `/s`.
 *
 * Module séparé (pas dans `lib/actions/auth.ts`, `'use server'`) : Next.js exige que tout export
 * d'un fichier `'use server'` soit une fonction async — cette fonction pure doit rester
 * unitairement testable en synchrone.
 */
const SHOPIFY_EMBEDDED_LINK_PATH = '/shopify/embedded-link';
const SHOPIFY_INSTALL_ENTRY_PATH = '/shopify/install-entry';

export function postSignInPath(redirectTo: string | undefined): string {
  const target = safeRedirectPath(redirectTo);

  if (target === '/s' || target.startsWith('/s/') || target.startsWith('/s?')) {
    return target;
  }

  if (
    target === SHOPIFY_EMBEDDED_LINK_PATH ||
    target.startsWith(`${SHOPIFY_EMBEDDED_LINK_PATH}?`)
  ) {
    return target;
  }

  if (target === SHOPIFY_INSTALL_ENTRY_PATH) {
    return target;
  }

  if (target === SHOPIFY_SHOPS_ARRIVAL_PATH) {
    return target;
  }

  return `/s?next=${encodeURIComponent(target)}`;
}
