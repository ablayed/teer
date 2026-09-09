// Portée des versements affichés sur /livreurs — décision, pas défaut.
//
// Un versement (`cash_settlement`, migration 0017) n'a jamais porté de dimension
// boutique, et ne doit pas en porter : le cash d'un livreur est indivisible
// (0133, lignes 30-32 — mesure prod à l'appui, un livreur sert réellement deux
// boutiques et remet une enveloppe unique). `finance_kpis` laisse pour la même
// raison `cash_chez_livreurs` cross-boutiques (0064, lignes 12-14).
//
// Depuis 0133, /livreurs filtre pourtant son PARC de livreurs sur la boutique
// active : deux portées cohabitent sur le même écran. L'indice n'a de sens que
// là où elles divergent réellement — dès que le compte compte plus d'une
// boutique. Même règle que /finances, qui n'affiche `kpis.cashDriversAllShops`
// que lorsqu'un filtre boutique est actif, et laisse l'écran d'un marchand
// mono-boutique sans mention inutile.
//
// Module volontairement pur (aucun import de `env`, de client Supabase ni de
// `'use server'`) pour rester unit-testable.
export function shouldShowSettlementScopeNote(shopCount: number): boolean {
  return shopCount > 1;
}
