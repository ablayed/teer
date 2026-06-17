// Dérivation du « stock en main du livreur » depuis le ledger stock_movement.
// Source de vérité unique : le ledger. Aucune table dédiée.
//
// Un mouvement de COMMANDE attribué à un livreur (driver_id non nul) affecte le
// stock qu'il détient physiquement. Le signe `qty` du ledger encode l'effet
// ENTREPÔT (négatif = sortie d'entrepôt). L'effet sur la main du livreur est
// l'OPPOSÉ :
//   dispatch (qty < 0)                 →  +|qty| en main
//   sold / courier_return (qty > 0)    →  −qty en main
//
// Phase 12 : le mode « lot d'avance » est retiré de bout en bout. Les mouvements
// lot (allocate_to_courier / courier_return_lot) restent LISIBLES en base
// (historique inerte) mais ne comptent PLUS dans le stock en main affiché — un
// éventuel résidu hérité n'apparaît donc plus à l'écran, et plus aucun lot n'est
// créable. L'invariant « entrepôt + en main = ledger » s'entend désormais HORS
// types lot, des deux côtés.
//
// reserve / release portent aussi un driver_id (transition_order) mais
// concernent la réserve molle en entrepôt, AVANT que le stock parte chez le
// livreur — ils sont exclus. purchase_in / manual_adjustment n'ont pas de livreur.

export const DRIVER_HAND_MOVEMENT_TYPES = ['dispatch', 'sold', 'courier_return'] as const;

export type DriverHandMovementType = (typeof DRIVER_HAND_MOVEMENT_TYPES)[number];

export type DriverStockMovement = {
  driver_id: string | null;
  product_id: string;
  movement_type: string;
  qty: number;
};

export type DriverProductStock = {
  driverId: string;
  productId: string;
  qtyOnHand: number;
};

function isHandMovement(type: string): type is DriverHandMovementType {
  return (DRIVER_HAND_MOVEMENT_TYPES as readonly string[]).includes(type);
}

/**
 * Réduit une liste de mouvements en stock en main par livreur×produit.
 * Retourne une Map driverId → (Map productId → qty en main).
 * Les positions nulles ou négatives ne sont pas filtrées ici (laissé à l'appelant).
 */
export function deriveDriverStockOnHand(
  movements: DriverStockMovement[],
): Map<string, Map<string, number>> {
  const byDriver = new Map<string, Map<string, number>>();

  for (const m of movements) {
    if (m.driver_id === null) continue;
    if (!isHandMovement(m.movement_type)) continue;

    const contribution = -m.qty;
    let byProduct = byDriver.get(m.driver_id);
    if (!byProduct) {
      byProduct = new Map<string, number>();
      byDriver.set(m.driver_id, byProduct);
    }
    byProduct.set(m.product_id, (byProduct.get(m.product_id) ?? 0) + contribution);
  }

  return byDriver;
}

/** Stock en main d'un livreur donné, en lignes filtrées (qty <> 0). */
export function driverStockRows(
  movements: DriverStockMovement[],
  driverId: string,
): DriverProductStock[] {
  const byProduct = deriveDriverStockOnHand(movements).get(driverId);
  if (!byProduct) return [];
  return [...byProduct.entries()]
    .filter(([, qty]) => qty !== 0)
    .map(([productId, qtyOnHand]) => ({ driverId, productId, qtyOnHand }));
}
