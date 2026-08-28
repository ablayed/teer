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
        },
      ],
      productAdSpend: [{ productId: 'p1', amountMinor: 66_700 }],
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
        },
      ],
      productAdSpend: [],
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
        },
      ],
      productAdSpend: [],
    });
    expect(result).toEqual({
      ok: true,
      allocationMethodAvailable: false,
      reason: 'missing_weight',
      allocationMethod: 'weight',
    });
  });
});

describe('assemblePurchaseLotProfitability — publicité multi-lignes du même produit (répartition TS)', () => {
  it('un produit avec deux lignes (qty 5 et 3) et 1000 F de publicité totale : 625/375, somme exacte', () => {
    const result = assemblePurchaseLotProfitability({
      purchaseLotId: 'lot-multi',
      transportTotalMinor: 0,
      transportComplete: true,
      allocationMethod: 'quantity',
      lines: [
        {
          purchaseLotLineId: 'line-a',
          productId: 'p1',
          qtyReceived: 5,
          qtySold: 5,
          purchaseValueMinor: 50_000,
          weightGrams: null,
          cashCollectedMinor: 100_000,
        },
        {
          purchaseLotLineId: 'line-b',
          productId: 'p1',
          qtyReceived: 3,
          qtySold: 3,
          purchaseValueMinor: 30_000,
          weightGrams: null,
          cashCollectedMinor: 60_000,
        },
      ],
      productAdSpend: [{ productId: 'p1', amountMinor: 1_000 }],
    });

    if (!result.ok || !result.allocationMethodAvailable) throw new Error('unexpected shape');

    const byLine = new Map(result.lines.map((l) => [l.purchaseLotLineId, l]));
    const lineA = byLine.get('line-a');
    const lineB = byLine.get('line-b');
    if (!lineA || !lineB) throw new Error('missing lines');

    // adSpendMinor par ligne n'est pas exposé directement sur le résultat —
    // on le retrouve en inversant la formule de la marge (marge = CA −
    // revient des vendus − publicité), les deux autres termes étant connus
    // (costOfSoldMinor exposé, cashCollectedMinor fourni en entrée).
    const adSpendA = 100_000 - lineA.costOfSoldMinor - lineA.marginMinor;
    const adSpendB = 60_000 - lineB.costOfSoldMinor - lineB.marginMinor;

    // Trace à la main : floor(1000*5/8)=625, floor(1000*3/8)=375, somme=1000
    // (division exacte, aucune ambiguïté sur le reliquat).
    expect(adSpendA).toBe(625);
    expect(adSpendB).toBe(375);
    expect(Number.isInteger(adSpendA)).toBe(true);
    expect(Number.isInteger(adSpendB)).toBe(true);
    expect(adSpendA + adSpendB).toBe(1_000);
    expect(result.totals.adSpendMinor).toBe(1_000);
  });

  it('un produit avec une seule ligne dans le lot reçoit 100 % de sa publicité (cas trivial)', () => {
    const result = assemblePurchaseLotProfitability({
      purchaseLotId: 'lot-single',
      transportTotalMinor: 0,
      transportComplete: true,
      allocationMethod: 'quantity',
      lines: [
        {
          purchaseLotLineId: 'line-a',
          productId: 'p1',
          qtyReceived: 5,
          qtySold: 5,
          purchaseValueMinor: 50_000,
          weightGrams: null,
          cashCollectedMinor: 100_000,
        },
      ],
      productAdSpend: [{ productId: 'p1', amountMinor: 1_000 }],
    });

    if (!result.ok || !result.allocationMethodAvailable) throw new Error('unexpected shape');
    const lineA = result.lines[0];
    const adSpendA = 100_000 - lineA.costOfSoldMinor - lineA.marginMinor;
    expect(adSpendA).toBe(1_000);
  });
});
