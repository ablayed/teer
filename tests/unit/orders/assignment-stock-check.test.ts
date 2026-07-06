import { computeStockShortages } from '@/lib/orders/assignment-stock-check';
import { describe, expect, it } from 'vitest';

const PROD_A = 'prod-a';
const PROD_B = 'prod-b';

describe('computeStockShortages', () => {
  it('disponible suffisant : aucun shortage', () => {
    const shortages = computeStockShortages(
      [{ productId: PROD_A, title: 'Produit A', requiredQty: 3 }],
      [{ productId: PROD_A, qtyAvailable: 5 }],
    );
    expect(shortages).toEqual([]);
  });

  it('disponible insuffisant : shortage exact', () => {
    const shortages = computeStockShortages(
      [{ productId: PROD_A, title: 'Produit A', requiredQty: 5 }],
      [{ productId: PROD_A, qtyAvailable: 2 }],
    );
    expect(shortages).toEqual([
      { productId: PROD_A, title: 'Produit A', requiredQty: 5, availableQty: 2, missingQty: 3 },
    ]);
  });

  it('produit absent du disponible : available = 0', () => {
    const shortages = computeStockShortages(
      [{ productId: PROD_A, title: 'Produit A', requiredQty: 4 }],
      [],
    );
    expect(shortages).toEqual([
      { productId: PROD_A, title: 'Produit A', requiredQty: 4, availableQty: 0, missingQty: 4 },
    ]);
  });

  it('disponible négatif : missing = required - negative', () => {
    // Livreur déjà sur-engagé (order_assignment_commit au-delà de la main physique,
    // cf. Lot 2 / PR 2) : required=2, available=-3 → missing=5.
    const shortages = computeStockShortages(
      [{ productId: PROD_A, title: 'Produit A', requiredQty: 2 }],
      [{ productId: PROD_A, qtyAvailable: -3 }],
    );
    expect(shortages).toEqual([
      { productId: PROD_A, title: 'Produit A', requiredQty: 2, availableQty: -3, missingQty: 5 },
    ]);
  });

  it('plusieurs produits : comparaison strictement par produit', () => {
    const shortages = computeStockShortages(
      [
        { productId: PROD_A, title: 'Produit A', requiredQty: 5 },
        { productId: PROD_B, title: 'Produit B', requiredQty: 2 },
      ],
      [
        { productId: PROD_A, qtyAvailable: 10 }, // excédent A ne doit pas compenser B
        { productId: PROD_B, qtyAvailable: 1 },
      ],
    );
    expect(shortages).toEqual([
      { productId: PROD_B, title: 'Produit B', requiredQty: 2, availableQty: 1, missingQty: 1 },
    ]);
  });

  it('disponible exactement zéro : missing = required', () => {
    const shortages = computeStockShortages(
      [{ productId: PROD_A, title: 'Produit A', requiredQty: 6 }],
      [{ productId: PROD_A, qtyAvailable: 0 }],
    );
    expect(shortages).toEqual([
      { productId: PROD_A, title: 'Produit A', requiredQty: 6, availableQty: 0, missingQty: 6 },
    ]);
  });
});
