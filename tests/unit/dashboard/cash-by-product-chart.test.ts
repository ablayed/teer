import {
  buildCashByProductChartRows,
  formatCashByProductCompactAmount,
  truncateCashByProductLabel,
} from '@/lib/dashboard/cash-by-product-chart';
import { describe, expect, it } from 'vitest';

describe('cash by product chart helpers', () => {
  it('formate le montant compact pour les labels de barres', () => {
    expect(formatCashByProductCompactAmount(285_600)).toBe('285,6 k F');
    expect(formatCashByProductCompactAmount(2_000_000)).toBe('2 M F');
  });

  it('tronque les noms longs avec une ellipse', () => {
    expect(truncateCashByProductLabel('GSX1- Souris ergonomique sans fil rechargeable', 24)).toBe(
      'GSX1- Souris ergonomiqu…',
    );
  });

  it('garde le top 7 positif et prépare les libellés courts', () => {
    const rows = buildCashByProductChartRows(
      Array.from({ length: 9 }, (_, index) => ({
        productId: `p-${index}`,
        qtySold: 1,
        revenueMinor: index === 8 ? 0 : 10_000 - index,
        title: `Produit visuel extra long ${index}`,
      })),
      { maxLabelLength: 18 },
    );

    expect(rows).toHaveLength(7);
    expect(rows[0]).toMatchObject({
      productId: 'p-0',
      revenueMinor: 10_000,
      shortTitle: 'Produit visuel ex…',
    });
  });
});
