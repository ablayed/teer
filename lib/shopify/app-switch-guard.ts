// APP-03 / Lot 2 — garde distincte de `decideShopOwnership` (lib/shopify/ownership-guard.ts).
// `decideShopOwnership` confronte uniquement le tenant ; elle autorise une mise à jour dès lors
// que `merchant_account_id` correspond, quelle que soit l'app qui possède déjà la boutique. Sans
// cette seconde garde, un rattachement Teer Public écraserait silencieusement une boutique déjà
// possédée par une autre app du MÊME tenant (ex. KOBA) avant même l'échange de token — module pur
// pour rester mutation-testable sans stack Supabase.
export type ExistingShopAppOwnership = {
  shopify_client_id: string | null;
};

export type ShopAppSwitchDecision = { kind: 'ok' } | { kind: 'refuse' };

export function decideShopAppSwitch(
  existingShop: ExistingShopAppOwnership | null,
  requestingClientId: string,
): ShopAppSwitchDecision {
  if (!existingShop || !existingShop.shopify_client_id) {
    return { kind: 'ok' };
  }

  if (existingShop.shopify_client_id !== requestingClientId) {
    return { kind: 'refuse' };
  }

  return { kind: 'ok' };
}
