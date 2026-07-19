import {
  type BundleCompositionRow,
  type ComponentStockLevel,
  computeBundleDerivedAvailability,
  deriveBundleAvailabilities,
} from '@/lib/products/bundle-availability';
import { describe, expect, it } from 'vitest';

const SUPPORT = 'component-support';
const CABLE = 'component-cable';
const BUNDLE_A = 'bundle-a';
const BUNDLE_B = 'bundle-b';

function stock(productId: string, qtyOnHand: number, qtyReserved: number): ComponentStockLevel {
  return { productId, qtyOnHand, qtyReserved };
}

describe('computeBundleDerivedAvailability', () => {
  it('retourne null si le bundle n’a aucun composant configuré', () => {
    const result = computeBundleDerivedAvailability([], new Map());
    expect(result).toBeNull();
  });

  it('cas limite : composants à quantités différentes → le min correct est calculé', () => {
    // Support/2 requis, 10 en stock (0 réservé) → 5 assemblables.
    // Câble/1 requis, 3 en stock → 3 assemblables. Le plus restrictif = Câble.
    const stockByComponent = new Map([
      [SUPPORT, stock(SUPPORT, 10, 0)],
      [CABLE, stock(CABLE, 3, 0)],
    ]);
    const result = computeBundleDerivedAvailability(
      [
        { componentProductId: SUPPORT, quantity: 2 },
        { componentProductId: CABLE, quantity: 1 },
      ],
      stockByComponent,
    );
    expect(result).toBe(3);
  });

  it('un composant à stock négatif fait apparaître une disponibilité bundle négative, sans plancher', () => {
    // Support/1 requis, disponible = -2 (qty_on_hand=0, qty_reserved=2) → -2 assemblables.
    // Câble/1 requis, 10 disponibles → 10 assemblables. Min = -2 (pas 0).
    const stockByComponent = new Map([
      [SUPPORT, stock(SUPPORT, 0, 2)],
      [CABLE, stock(CABLE, 10, 0)],
    ]);
    const result = computeBundleDerivedAvailability(
      [
        { componentProductId: SUPPORT, quantity: 1 },
        { componentProductId: CABLE, quantity: 1 },
      ],
      stockByComponent,
    );
    expect(result).toBe(-2);
  });

  it('division non entière : floor vers le bas, y compris pour un disponible négatif', () => {
    // disponible = -1, quantité requise = 2 → floor(-1/2) = -1 (pas 0, pas -0.5 arrondi vers le haut).
    const stockByComponent = new Map([[SUPPORT, stock(SUPPORT, -1, 0)]]);
    const result = computeBundleDerivedAvailability(
      [{ componentProductId: SUPPORT, quantity: 2 }],
      stockByComponent,
    );
    expect(result).toBe(-1);
  });

  it('un composant sans ligne product_stock est traité comme 0/0 (jamais crash)', () => {
    const result = computeBundleDerivedAvailability(
      [{ componentProductId: SUPPORT, quantity: 3 }],
      new Map(),
    );
    expect(result).toBe(0);
  });
});

describe('deriveBundleAvailabilities', () => {
  it('calcule la disponibilité de plusieurs bundles indépendamment, y compris un composant partagé', () => {
    const rows: BundleCompositionRow[] = [
      { bundleProductId: BUNDLE_A, componentProductId: SUPPORT, quantity: 2 },
      { bundleProductId: BUNDLE_A, componentProductId: CABLE, quantity: 1 },
      { bundleProductId: BUNDLE_B, componentProductId: SUPPORT, quantity: 1 },
    ];
    const stockByComponent = new Map([
      [SUPPORT, stock(SUPPORT, 10, 0)],
      [CABLE, stock(CABLE, 3, 0)],
    ]);

    const result = deriveBundleAvailabilities(rows, stockByComponent);

    expect(result.get(BUNDLE_A)).toBe(3); // min(floor(10/2)=5, floor(3/1)=3)
    expect(result.get(BUNDLE_B)).toBe(10); // floor(10/1)=10
  });

  it('un bundle absent des lignes de composition ne figure pas dans le résultat', () => {
    const result = deriveBundleAvailabilities([], new Map());
    expect(result.size).toBe(0);
  });
});
