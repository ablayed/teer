// APP-03 / Lot 1 — décision de propriété avant écriture, isolée dans un module pur (aucun
// import `env`/Supabase/`'use server'`, cf. gotcha lib/env.ts) pour rester unitairement
// testable et mutation-testable sans stack Supabase. Le callback OAuth (route.ts) confronte
// une lecture unique de `shop` (par `shop_domain`) au tenant demandeur AVANT tout échange de
// code et toute écriture : c'est cette seule décision qui conditionne les deux écritures.
export type ExistingShopOwnership = {
  id: string;
  merchant_account_id: string;
};

export type ShopOwnershipDecision =
  | { kind: 'insert' }
  | { kind: 'update'; shopId: string }
  | { kind: 'refuse' };

export function decideShopOwnership(
  existingShop: ExistingShopOwnership | null,
  requestingMerchantAccountId: string,
): ShopOwnershipDecision {
  if (!existingShop) {
    return { kind: 'insert' };
  }

  if (existingShop.merchant_account_id !== requestingMerchantAccountId) {
    return { kind: 'refuse' };
  }

  return { kind: 'update', shopId: existingShop.id };
}
