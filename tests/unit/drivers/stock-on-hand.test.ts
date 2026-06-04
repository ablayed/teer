import {
  type DriverStockMovement,
  deriveDriverStockOnHand,
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
