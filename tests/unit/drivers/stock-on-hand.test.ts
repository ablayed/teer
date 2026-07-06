import {
  type DriverStockMovement,
  deriveDriverAvailableStock,
  deriveDriverStockOnHand,
  driverAvailableStockRows,
  driverStockRows,
} from '@/lib/drivers/stock-on-hand';
import { describe, expect, it } from 'vitest';

const DRIVER = 'driver-1';
const OTHER = 'driver-2';
const PROD_A = 'prod-a';
const PROD_B = 'prod-b';

function mv(partial: Partial<DriverStockMovement>): DriverStockMovement {
  return {
    driver_id: DRIVER,
    product_id: PROD_A,
    movement_type: 'dispatch',
    qty: -1,
    ...partial,
  };
}

describe('deriveDriverStockOnHand', () => {
  it('mode par commande: dispatch (qty<0) augmente le stock en main', () => {
    const map = deriveDriverStockOnHand([mv({ movement_type: 'dispatch', qty: -3 })]);
    expect(map.get(DRIVER)?.get(PROD_A)).toBe(3);
  });

  it('mode lot: allocate_to_courier (qty<0) augmente le stock en main', () => {
    const map = deriveDriverStockOnHand([mv({ movement_type: 'allocate_to_courier', qty: -10 })]);
    expect(map.get(DRIVER)?.get(PROD_A)).toBe(10);
  });

  it('sold et courier_return_lot diminuent le stock en main', () => {
    const map = deriveDriverStockOnHand([
      mv({ movement_type: 'allocate_to_courier', qty: -10 }),
      mv({ movement_type: 'sold', qty: 4 }),
      mv({ movement_type: 'courier_return_lot', qty: 6 }),
    ]);
    expect(map.get(DRIVER)?.get(PROD_A)).toBe(0);
  });

  it("reassign_from_driver (qty>0) débite l'ancien livreur, reassign_to_driver (qty<0) crédite le nouveau", () => {
    const map = deriveDriverStockOnHand([
      mv({ driver_id: DRIVER, movement_type: 'dispatch', qty: -2 }),
      mv({ driver_id: DRIVER, movement_type: 'reassign_from_driver', qty: 2 }),
      mv({ driver_id: OTHER, movement_type: 'reassign_to_driver', qty: -2 }),
    ]);
    expect(map.get(DRIVER)?.get(PROD_A)).toBe(0);
    expect(map.get(OTHER)?.get(PROD_A)).toBe(2);
  });

  it('reserve et release sont exclus (réserve entrepôt, pré-dispatch)', () => {
    const map = deriveDriverStockOnHand([
      mv({ movement_type: 'reserve', qty: 5 }),
      mv({ movement_type: 'release', qty: -5 }),
    ]);
    expect(map.get(DRIVER)).toBeUndefined();
  });

  it('purchase_in / manual_adjustment sans livreur sont ignorés', () => {
    const map = deriveDriverStockOnHand([
      { driver_id: null, product_id: PROD_A, movement_type: 'purchase_in', qty: 100 },
      { driver_id: null, product_id: PROD_A, movement_type: 'manual_adjustment', qty: -2 },
    ]);
    expect(map.size).toBe(0);
  });

  it('sépare les livreurs et les produits', () => {
    const map = deriveDriverStockOnHand([
      mv({ driver_id: DRIVER, product_id: PROD_A, movement_type: 'dispatch', qty: -2 }),
      mv({ driver_id: DRIVER, product_id: PROD_B, movement_type: 'allocate_to_courier', qty: -5 }),
      mv({ driver_id: OTHER, product_id: PROD_A, movement_type: 'dispatch', qty: -7 }),
    ]);
    expect(map.get(DRIVER)?.get(PROD_A)).toBe(2);
    expect(map.get(DRIVER)?.get(PROD_B)).toBe(5);
    expect(map.get(OTHER)?.get(PROD_A)).toBe(7);
  });
});

describe('driverStockRows', () => {
  it('filtre les positions nulles et renvoie les lignes du livreur', () => {
    const rows = driverStockRows(
      [
        mv({ product_id: PROD_A, movement_type: 'allocate_to_courier', qty: -5 }),
        mv({ product_id: PROD_A, movement_type: 'sold', qty: 5 }), // net 0 → filtré
        mv({ product_id: PROD_B, movement_type: 'dispatch', qty: -3 }),
      ],
      DRIVER,
    );
    expect(rows).toEqual([{ driverId: DRIVER, productId: PROD_B, qtyOnHand: 3 }]);
  });

  it('renvoie [] pour un livreur sans mouvement', () => {
    expect(driverStockRows([], DRIVER)).toEqual([]);
  });
});

describe('deriveDriverAvailableStock', () => {
  it('dispatch (main) + order_assignment_commit (engagement) → disponible cohérent', () => {
    // 5 dispatchés au livreur, dont 3 engagés sur une commande ouverte → 2 disponibles.
    const map = deriveDriverAvailableStock([
      mv({ movement_type: 'dispatch', qty: -5 }),
      mv({ movement_type: 'order_assignment_commit', qty: 3 }),
    ]);
    expect(map.get(DRIVER)?.get(PROD_A)).toBe(2);
  });

  it('order_assignment_commit au-delà de la possession physique → disponible négatif', () => {
    // 2 en main, 5 engagés (avance sur un futur dispatch) → -3 disponible, visible tel quel.
    const map = deriveDriverAvailableStock([
      mv({ movement_type: 'dispatch', qty: -2 }),
      mv({ movement_type: 'order_assignment_commit', qty: 5 }),
    ]);
    expect(map.get(DRIVER)?.get(PROD_A)).toBe(-3);
  });

  it('order_assignment_release restaure le disponible engagé', () => {
    const map = deriveDriverAvailableStock([
      mv({ movement_type: 'dispatch', qty: -5 }),
      mv({ movement_type: 'order_assignment_commit', qty: 5 }),
      mv({ movement_type: 'order_assignment_release', qty: -5 }),
    ]);
    expect(map.get(DRIVER)?.get(PROD_A)).toBe(5);
  });

  it('sold diminue le disponible (livré, quitte la main du livreur)', () => {
    const map = deriveDriverAvailableStock([
      mv({ movement_type: 'dispatch', qty: -5 }),
      mv({ movement_type: 'order_assignment_commit', qty: 5 }),
      mv({ movement_type: 'sold', qty: 5 }),
    ]);
    expect(map.get(DRIVER)?.get(PROD_A)).toBe(-5);
  });

  it('courier_return diminue le disponible (repris par l’entrepôt)', () => {
    const map = deriveDriverAvailableStock([
      mv({ movement_type: 'dispatch', qty: -5 }),
      mv({ movement_type: 'courier_return', qty: 2 }),
    ]);
    expect(map.get(DRIVER)?.get(PROD_A)).toBe(3);
  });

  it('allocate_to_courier / courier_return_lot (mode lot, hors commande)', () => {
    const map = deriveDriverAvailableStock([
      mv({ movement_type: 'allocate_to_courier', qty: -10 }),
      mv({ movement_type: 'courier_return_lot', qty: 4 }),
    ]);
    expect(map.get(DRIVER)?.get(PROD_A)).toBe(6);
  });

  it('reassign_from_driver / reassign_to_driver déplacent le disponible entre livreurs', () => {
    const map = deriveDriverAvailableStock([
      mv({ driver_id: DRIVER, movement_type: 'dispatch', qty: -4 }),
      mv({ driver_id: DRIVER, movement_type: 'reassign_from_driver', qty: 4 }),
      mv({ driver_id: OTHER, movement_type: 'reassign_to_driver', qty: -4 }),
    ]);
    expect(map.get(DRIVER)?.get(PROD_A)).toBe(0);
    expect(map.get(OTHER)?.get(PROD_A)).toBe(4);
  });

  it('reserve / release / purchase_in / manual_adjustment / advance_commit sont exclus', () => {
    const map = deriveDriverAvailableStock([
      mv({ movement_type: 'reserve', qty: 5 }),
      mv({ movement_type: 'release', qty: -5 }),
      mv({ movement_type: 'advance_commit', qty: 3 }),
      { driver_id: null, product_id: PROD_A, movement_type: 'purchase_in', qty: 100 },
      { driver_id: null, product_id: PROD_A, movement_type: 'manual_adjustment', qty: -2 },
    ]);
    expect(map.get(DRIVER)).toBeUndefined();
  });
});

describe('driverAvailableStockRows', () => {
  it('inclut les positions négatives', () => {
    const rows = driverAvailableStockRows(
      [
        mv({ product_id: PROD_A, movement_type: 'dispatch', qty: -2 }),
        mv({ product_id: PROD_A, movement_type: 'order_assignment_commit', qty: 5 }),
      ],
      DRIVER,
    );
    expect(rows).toEqual([{ driverId: DRIVER, productId: PROD_A, qtyAvailable: -3 }]);
  });

  it('order_assignment_release compense exactement un commit sans annuler le stock en main', () => {
    const rows = driverAvailableStockRows(
      [
        mv({ product_id: PROD_A, movement_type: 'dispatch', qty: -5 }),
        mv({ product_id: PROD_A, movement_type: 'order_assignment_commit', qty: 3 }),
        mv({ product_id: PROD_A, movement_type: 'order_assignment_release', qty: -3 }),
        mv({ product_id: PROD_B, movement_type: 'dispatch', qty: -3 }),
      ],
      DRIVER,
    );
    // PROD_A : 5 en main, engagement clos (commit puis release intégral) → 5, pas 0.
    expect(rows.find((r) => r.productId === PROD_A)?.qtyAvailable).toBe(5);
    expect(rows.find((r) => r.productId === PROD_B)?.qtyAvailable).toBe(3);
  });

  it('exclut une position dont le disponible net est exactement zéro', () => {
    const rows = driverAvailableStockRows(
      [
        // dispatché puis intégralement engagé sur une commande ouverte → 0 disponible.
        mv({ product_id: PROD_A, movement_type: 'dispatch', qty: -3 }),
        mv({ product_id: PROD_A, movement_type: 'order_assignment_commit', qty: 3 }),
        mv({ product_id: PROD_B, movement_type: 'dispatch', qty: -2 }),
      ],
      DRIVER,
    );
    expect(rows).toEqual([{ driverId: DRIVER, productId: PROD_B, qtyAvailable: 2 }]);
  });

  it('renvoie [] pour un livreur sans mouvement', () => {
    expect(driverAvailableStockRows([], DRIVER)).toEqual([]);
  });
});
