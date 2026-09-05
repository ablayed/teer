import {
  type StockCatalogRow,
  computeStockCatalogSummary,
  isRowLowStock,
  isStockCostMissing,
} from '@/lib/stock/stock-catalog-facts';
import { describe, expect, it } from 'vitest';

function row(overrides: Partial<StockCatalogRow>): StockCatalogRow {
  return {
    productId: 'p',
    qtyOnHand: 0,
    qtyReserved: 0,
    unitCost: 0,
    lowStockThreshold: 10,
    isBundle: false,
    ...overrides,
  };
}

describe('isStockCostMissing', () => {
  it('treats unit_cost <= 0 as missing, matching lib/finance costMissing convention', () => {
    expect(isStockCostMissing(0)).toBe(true);
    expect(isStockCostMissing(-1)).toBe(true);
    expect(isStockCostMissing(1)).toBe(false);
  });
});

describe('isRowLowStock', () => {
  it('matches the exact formula already used at lib/actions/products.ts:232/:455 (qtyOnHand <= threshold)', () => {
    expect(isRowLowStock(5, 10)).toBe(true);
    expect(isRowLowStock(10, 10)).toBe(true);
    expect(isRowLowStock(11, 10)).toBe(false);
  });
});

describe('computeStockCatalogSummary', () => {
  it('case "zéro réel" : tous les coûts connus, total à zéro', () => {
    const rows = [
      row({ productId: 'a', qtyOnHand: 0, unitCost: 5000 }),
      row({ productId: 'b', qtyOnHand: 0, unitCost: 3000 }),
    ];
    const summary = computeStockCatalogSummary(rows);
    expect(summary.totalValueMinor).toBe(0);
    expect(summary.costUnknownCount).toBe(0);
  });

  it('case "valeur partielle" : un coût manquant, un sous-total réel sur le reste', () => {
    const rows = [
      row({ productId: 'a', qtyOnHand: 10, unitCost: 500 }), // 5000, connu
      row({ productId: 'b', qtyOnHand: 4, unitCost: 0 }), // coût jamais saisi, qty > 0
    ];
    const summary = computeStockCatalogSummary(rows);
    expect(summary.totalValueMinor).toBe(5000);
    expect(summary.costUnknownCount).toBe(1);
  });

  it('case "rien de calculable" : aucun produit avec un coût connu', () => {
    const rows = [row({ productId: 'a', qtyOnHand: 4, unitCost: 0 })];
    const summary = computeStockCatalogSummary(rows);
    expect(summary.totalValueMinor).toBeNull();
    expect(summary.costUnknownCount).toBe(1);
  });

  it('exclut les bundles du total et du compteur de coût manquant', () => {
    const rows = [row({ productId: 'bundle', isBundle: true, qtyOnHand: 0, unitCost: 0 })];
    const summary = computeStockCatalogSummary(rows);
    expect(summary.totalValueMinor).toBeNull();
    expect(summary.costUnknownCount).toBe(0);
  });

  it('le lowStockCount et lowStockProductIds viennent du même prédicat, catalogue > 25 lignes', () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      row({
        productId: `p${i}`,
        qtyOnHand: i < 26 ? 1 : 100, // 26 premières lignes en dessous du seuil 10
        lowStockThreshold: 10,
      }),
    );
    const summary = computeStockCatalogSummary(rows);
    expect(summary.lowStockCount).toBe(26);
    expect(summary.lowStockProductIds).toHaveLength(26);
    expect(new Set(summary.lowStockProductIds).size).toBe(summary.lowStockCount);
  });

  it('un coût manquant à qty=0 ne compte pas comme "coût manquant" (rien à valoriser)', () => {
    const rows = [row({ productId: 'a', qtyOnHand: 0, unitCost: 0 })];
    const summary = computeStockCatalogSummary(rows);
    expect(summary.costUnknownCount).toBe(0);
    expect(summary.totalValueMinor).toBe(0);
  });
});
