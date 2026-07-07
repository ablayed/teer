// Dérivation du « stock en main du livreur » depuis le ledger stock_movement.
// Source de vérité unique : le ledger. Aucune table dédiée.
//
// Un mouvement attribué à un livreur (driver_id non nul) affecte le stock
// qu'il détient physiquement. Le signe `qty` du ledger encode l'effet ENTREPÔT
// (négatif = sortie d'entrepôt). L'effet sur la main du livreur est l'OPPOSÉ :
//   dispatch / allocate_to_courier (qty < 0)  →  +|qty| en main
//   sold / courier_return / courier_return_lot (qty > 0)  →  −qty en main
//
// reserve / release portent aussi un driver_id (transition_order) mais
// concernent la réserve molle en entrepôt, AVANT que le stock parte chez le
// livreur — ils sont exclus. purchase_in / manual_adjustment n'ont pas de livreur.
//
// reassign_from_driver (qty > 0, entrepôt reprend) / reassign_to_driver
// (qty < 0, entrepôt confie) suivent la même convention de signe que
// dispatch/sold : la formule `-qty` ci-dessous déplace le stock de l'ancien
// livreur (main −qty) vers le nouveau (main +qty) sans changement de code dédié.
//
// driver_stock_set (Lot 4b+4c / PR 2) est un CAS À PART : n'ayant aucune
// contrepartie entrepôt (ledger-only, ne mute jamais product_stock), son
// `qty` encode DIRECTEMENT le delta en main ("le livreur a maintenant X" −
// stock physique actuel), pas un effet entrepôt inversé. Contribution = +qty,
// pas −qty — seul type de DRIVER_HAND_MOVEMENT_TYPES dans ce cas, isolé
// explicitement dans deriveDriverStockOnHand/deriveDriverAvailableStock.

export const DRIVER_HAND_MOVEMENT_TYPES = [
  'dispatch',
  'allocate_to_courier',
  'sold',
  'courier_return',
  'courier_return_lot',
  'reassign_from_driver',
  'reassign_to_driver',
  'driver_stock_set',
] as const;

// Types dont le qty encode DIRECTEMENT le delta en main (pas l'effet entrepôt
// inversé) — contribution = +qty. Actuellement seul driver_stock_set.
const DIRECT_HAND_DELTA_TYPES: readonly string[] = ['driver_stock_set'];

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

    const contribution = DIRECT_HAND_DELTA_TYPES.includes(m.movement_type) ? m.qty : -m.qty;
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

// Stock DISPONIBLE d'un livreur (Lot 2 / PR 2) : le stock en main ci-dessus,
// diminué de l'engagement net envers des commandes ouvertes (ledger
// order_assignment_commit/release, PR 1). Ces deux types ne touchent jamais
// product_stock (post_stock_movement les court-circuite) — ils suivent la
// MÊME convention de signe que les mouvements physiques ci-dessus :
//   order_assignment_commit  (qty > 0)  →  −qty  (réduit le disponible)
//   order_assignment_release (qty < 0)  →  −qty  (restaure le disponible)
// La formule est donc une simple extension de l'ensemble de types sommés,
// pas une formule séparée : Σ(−qty) sur DRIVER_HAND_MOVEMENT_TYPES ∪ ces deux
// types de ledger, groupé par livreur × produit.

export const DRIVER_AVAILABLE_MOVEMENT_TYPES = [
  ...DRIVER_HAND_MOVEMENT_TYPES,
  'order_assignment_commit',
  'order_assignment_release',
] as const;

export type DriverAvailableMovementType = (typeof DRIVER_AVAILABLE_MOVEMENT_TYPES)[number];

export type DriverProductAvailability = {
  driverId: string;
  productId: string;
  qtyAvailable: number;
};

function isAvailableMovement(type: string): type is DriverAvailableMovementType {
  return (DRIVER_AVAILABLE_MOVEMENT_TYPES as readonly string[]).includes(type);
}

/**
 * Réduit une liste de mouvements en stock DISPONIBLE par livreur×produit.
 * Retourne une Map driverId → (Map productId → qty disponible, signée).
 * Les positions nulles ne sont pas filtrées ici (laissé à l'appelant).
 */
export function deriveDriverAvailableStock(
  movements: DriverStockMovement[],
): Map<string, Map<string, number>> {
  const byDriver = new Map<string, Map<string, number>>();

  for (const m of movements) {
    if (m.driver_id === null) continue;
    if (!isAvailableMovement(m.movement_type)) continue;

    const contribution = DIRECT_HAND_DELTA_TYPES.includes(m.movement_type) ? m.qty : -m.qty;
    let byProduct = byDriver.get(m.driver_id);
    if (!byProduct) {
      byProduct = new Map<string, number>();
      byDriver.set(m.driver_id, byProduct);
    }
    byProduct.set(m.product_id, (byProduct.get(m.product_id) ?? 0) + contribution);
  }

  return byDriver;
}

/**
 * Stock disponible d'un livreur donné, en lignes filtrées (qty <> 0).
 * Positions négatives incluses (commandes assignées au-delà de la possession
 * physique) — seule une somme nette EXACTEMENT nulle est exclue.
 */
export function driverAvailableStockRows(
  movements: DriverStockMovement[],
  driverId: string,
): DriverProductAvailability[] {
  const byProduct = deriveDriverAvailableStock(movements).get(driverId);
  if (!byProduct) return [];
  return [...byProduct.entries()]
    .filter(([, qty]) => qty !== 0)
    .map(([productId, qtyAvailable]) => ({ driverId, productId, qtyAvailable }));
}
