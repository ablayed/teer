// Portée du cash et des versements livreur — décision, pas défaut.
//
// Un versement (`cash_settlement`, migration 0017) n'a jamais porté de dimension
// boutique, et ne doit pas en porter : le cash d'un livreur est indivisible
// (0133, lignes 30-32 — mesure prod à l'appui, un livreur sert réellement deux
// boutiques et remet une enveloppe unique). `finance_kpis` laisse pour la même
// raison `cash_chez_livreurs` cross-boutiques (0064, lignes 12-14), et
// `cash_aging(p_merchant)` (0017, ligne 183) n'a jamais eu de paramètre
// boutique.
//
// Ce qui doit être dit, c'est la portée — jamais la changer. La règle est unique
// et vit ici : l'indice « toutes boutiques » n'apparaît QUE lorsque la vue
// environnante est plus étroite que le chiffre affiché. Sinon il n'oppose rien,
// et un marchand mono-boutique lirait une précision inutile.
//
// Les deux surfaces se rétrécissent différemment — d'où le contexte discriminé,
// plutôt qu'une seconde implémentation qui dériverait de la première.
//
// Module volontairement pur (aucun import de `env`, de client Supabase ni de
// `'use server'`) pour rester unit-testable.

export type TenantCashScopeContext =
  // /livreurs : le parc de livreurs est TOUJOURS filtré sur la boutique active
  // (`getStoreDriverIds`, 0133), sans sélecteur. La divergence de portée existe
  // donc dès que le compte possède une deuxième boutique.
  | { surface: 'livreurs'; accessibleShopCount: number }
  // /finances : les autres blocs suivent le sélecteur `?shop=`. La divergence
  // n'existe que sous filtre actif — condition déjà appliquée à la carte
  // « Cash chez les livreurs » (`kpis.cashDriversAllShops`).
  | { surface: 'finances'; shopFilterActive: boolean };

export function shouldShowTenantCashScopeNote(context: TenantCashScopeContext): boolean {
  switch (context.surface) {
    case 'livreurs':
      return context.accessibleShopCount > 1;
    case 'finances':
      return context.shopFilterActive;
  }
}
