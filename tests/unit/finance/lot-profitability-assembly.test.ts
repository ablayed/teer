import { assemblePurchaseLotProfitability } from '@/lib/finance/lot-profitability-assembly';
import { describe, expect, it } from 'vitest';

describe('assemblePurchaseLotProfitability — contrôle de référence (arrivage du 27 avril)', () => {
  it('reproduit exactement 89 360 F / 21,9 %', () => {
    const result = assemblePurchaseLotProfitability({
      purchaseLotId: 'lot-1',
      transportTotalMinor: 0,
      transportComplete: true,
      allocationMethod: 'value',
      lines: [
        {
          purchaseLotLineId: 'line-1',
          productId: 'p1',
          qtyReceived: 20,
          qtySold: 19,
          purchaseValueMinor: 265_200,
          weightGrams: 5_000,
          cashCollectedMinor: 408_000,
          adSpendMinor: 66_700,
        },
      ],
    });

    if (!result.ok || !result.allocationMethodAvailable) throw new Error('unexpected shape');
    expect(result.totals.marginMinor).toBe(89_360);
    expect(result.totals.marginPct).toBeCloseTo(0.219, 3);
    expect(result.totals.complete).toBe(true);
  });

  it('lot introuvable -> not_found', () => {
    const result = assemblePurchaseLotProfitability(null);
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('transport pas encore connu -> marge provisoire nommant le transport', () => {
    const result = assemblePurchaseLotProfitability({
      purchaseLotId: 'lot-1',
      transportTotalMinor: 0,
      transportComplete: false,
      allocationMethod: 'value',
      lines: [
        {
          purchaseLotLineId: 'line-1',
          productId: 'p1',
          qtyReceived: 10,
          qtySold: 5,
          purchaseValueMinor: 100_000,
          weightGrams: null,
          cashCollectedMinor: 80_000,
          adSpendMinor: 0,
        },
      ],
    });
    if (!result.ok || !result.allocationMethodAvailable) throw new Error('unexpected shape');
    expect(result.totals.complete).toBe(false);
    expect(result.totals.missingInputs).toContain('transport_total');
  });

  it("méthode 'weight' indisponible si un poids manque -> allocationMethodAvailable=false, raison nommée", () => {
    const result = assemblePurchaseLotProfitability({
      purchaseLotId: 'lot-1',
      transportTotalMinor: 10_000,
      transportComplete: true,
      allocationMethod: 'weight',
      lines: [
        {
          purchaseLotLineId: 'line-1',
          productId: 'p1',
          qtyReceived: 10,
          qtySold: 5,
          purchaseValueMinor: 100_000,
          weightGrams: null,
          cashCollectedMinor: 80_000,
          adSpendMinor: 0,
        },
      ],
    });
    expect(result).toEqual({
      ok: true,
      allocationMethodAvailable: false,
      reason: 'missing_weight',
      allocationMethod: 'weight',
    });
  });
});
