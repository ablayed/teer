import {
  computeFinanceCollectedRevenueByProduct,
  computeFinanceProductCostReport,
} from '@/lib/finance/product-cost';
import { describe, expect, it } from 'vitest';

describe('computeFinanceProductCostReport', () => {
  it('réutilise le même pairing Finances pour le CA par produit dashboard', () => {
    const rows = computeFinanceCollectedRevenueByProduct({
      orderLines: [
        { orderId: 'o1', productId: 'p1', qty: 1, rawTitle: 'Sac' },
        { orderId: 'o1', productId: 'p2', qty: 1, rawTitle: 'Ceinture' },
        { orderId: 'o2', productId: 'p1', qty: 1, rawTitle: 'Sac' },
      ],
      orders: [
        {
          deliveryFeeMinor: 0,
          id: 'o1',
          itemsSummary: [
            { price: 10_000, quantity: 1, title: 'Sac' },
            { price: 5_000, quantity: 1, title: 'Ceinture' },
          ],
          totalAmount: 15_000,
        },
        {
          deliveryFeeMinor: 0,
          id: 'o2',
          itemsSummary: [
            { price: 9_500, quantity: 1, title: 'Sac' },
            { price: 2_500, quantity: 1, title: 'Produit libre' },
          ],
          totalAmount: 12_000,
        },
      ],
      products: [
        { id: 'p1', title: 'Sac', unitCost: 0 },
        { id: 'p2', title: 'Ceinture', unitCost: 0 },
      ],
    });

    expect(rows).toEqual([
      { productId: 'p1', qtySold: 2, revenueMinor: 19_500, title: 'Sac' },
      { productId: 'p2', qtySold: 1, revenueMinor: 5_000, title: 'Ceinture' },
    ]);
  });

  it('coût total (B) = prix d’achat CUMP (A) + pub + livraison, bénéfices appariés', () => {
    const report = computeFinanceProductCostReport({
      expenses: [{ amountMinor: 3_000, categoryCode: 'ADS' }],
      orderLines: [
        { orderId: 'o1', productId: 'p1', qty: 2, rawTitle: 'Sac' },
        { orderId: 'o1', productId: 'p2', qty: 1, rawTitle: 'Ceinture' },
      ],
      orders: [
        {
          deliveryFeeMinor: 900,
          id: 'o1',
          itemsSummary: [
            { price: 10_000, quantity: 2, title: 'Sac' },
            { price: 5_000, quantity: 1, title: 'Ceinture' },
          ],
          totalAmount: 25_900,
        },
      ],
      products: [
        { id: 'p1', title: 'Sac', unitCost: 5_000 },
        { id: 'p2', title: 'Ceinture', unitCost: 2_000 },
      ],
      soldMovements: [
        { productId: 'p1', qty: 2, unitCost: 5_000 },
        { productId: 'p2', qty: 1, unitCost: 2_000 },
      ],
    });

    const sac = report.rows.find((row) => row.productId === 'p1');
    const ceinture = report.rows.find((row) => row.productId === 'p2');

    // Prix d'achat = CUMP figé × qté (PAS « lots reçus ÷ vendus »).
    expect(sac).toMatchObject({
      adsAllocatedMinor: 2_400,
      costMissing: false,
      deliveryAllocatedMinor: 600,
      profitAfterMinor: 7_000, // 20000 − (10000 + 2400 + 600)
      profitBeforeMinor: 10_000, // 20000 − 10000
      purchasePriceMinor: 10_000,
      purchaseUnitMinor: 5_000,
      qtySold: 2,
      revenueMinor: 20_000,
      totalCostMinor: 13_000,
    });
    expect(ceinture).toMatchObject({
      adsAllocatedMinor: 600,
      deliveryAllocatedMinor: 300,
      profitAfterMinor: 2_100, // 5000 − (2000 + 600 + 300)
      profitBeforeMinor: 3_000,
      purchasePriceMinor: 2_000,
      qtySold: 1,
      revenueMinor: 5_000,
      totalCostMinor: 2_900,
    });

    // Invariant d'affichage : bénéfice après = CA − coût total, pour chaque ligne.
    for (const row of report.rows) {
      expect(row.profitAfterMinor).toBe(row.revenueMinor - row.totalCostMinor);
      expect(row.profitBeforeMinor).toBe(row.revenueMinor - row.purchasePriceMinor);
    }

    expect(report.totalAdsAllocatedMinor).toBe(3_000);
    expect(report.totalDeliveryAllocatedMinor).toBe(900);
    expect(report.totalPurchasePriceMinor).toBe(12_000);
    expect(report.totalCostMinor).toBe(15_900);
    expect(report.totalProfitAfterMinor).toBe(9_100);
    expect(report.unallocatedDeliveryMinor).toBe(0);
  });

  it('aucun bénéfice positif quand le coût dépasse le CA', () => {
    const report = computeFinanceProductCostReport({
      expenses: [{ amountMinor: 5_000, categoryCode: 'ADS' }],
      orderLines: [{ orderId: 'o1', productId: 'p1', qty: 1, rawTitle: 'Sac' }],
      orders: [
        {
          deliveryFeeMinor: 500,
          id: 'o1',
          itemsSummary: [{ price: 1_000, quantity: 1, title: 'Sac' }],
          totalAmount: 1_500,
        },
      ],
      products: [{ id: 'p1', title: 'Sac', unitCost: 2_000 }],
      soldMovements: [{ productId: 'p1', qty: 1, unitCost: 2_000 }],
    });

    const sac = report.rows.find((row) => row.productId === 'p1');
    // CUMP 2000 > CA 1000 → bénéfice avant ET après négatifs.
    expect(sac?.purchasePriceMinor).toBe(2_000);
    expect(sac?.profitBeforeMinor).toBeLessThan(0);
    expect(sac?.totalCostMinor).toBeGreaterThan(sac?.revenueMinor ?? 0);
    expect(sac?.profitAfterMinor).toBeLessThan(0);
  });

  it('marque le faible volume (qtySold < seuil) pour masquer l’unitaire', () => {
    const report = computeFinanceProductCostReport({
      expenses: [],
      orderLines: [{ orderId: 'o1', productId: 'p1', qty: 1, rawTitle: 'Sac' }],
      orders: [
        {
          deliveryFeeMinor: 0,
          id: 'o1',
          itemsSummary: [{ price: 10_000, quantity: 1, title: 'Sac' }],
          totalAmount: 10_000,
        },
      ],
      products: [{ id: 'p1', title: 'Sac', unitCost: 4_000 }],
      soldMovements: [{ productId: 'p1', qty: 1, unitCost: 4_000 }],
    });

    expect(report.rows.find((row) => row.productId === 'p1')?.lowVolume).toBe(true);
    expect(report.lowVolumeThreshold).toBe(3);
  });

  it('badge « coût manquant » quand aucun coût connu (unit_cost 0/null, sans COGS figé)', () => {
    // La colonne `product.unit_cost` est NOT NULL DEFAULT 0 : un produit jamais costé
    // vaut 0 (pas null). Par §2.4 (« inconnu/0 »), 0 + aucun COGS figé = coût manquant,
    // jamais un 0 silencieux à 100 % de marge.
    const report = computeFinanceProductCostReport({
      expenses: [],
      orderLines: [
        { orderId: 'o1', productId: 'p1', qty: 1, rawTitle: 'Zero' },
        { orderId: 'o1', productId: 'p2', qty: 1, rawTitle: 'Null' },
      ],
      orders: [
        {
          deliveryFeeMinor: 0,
          id: 'o1',
          itemsSummary: [
            { price: 6_000, quantity: 1, title: 'Zero' },
            { price: 4_000, quantity: 1, title: 'Null' },
          ],
          totalAmount: 10_000,
        },
      ],
      // p1 unit_cost 0 (cas réel, colonne NOT NULL) ; p2 null (défensif) → tous deux manquants.
      products: [
        { id: 'p1', title: 'Zero', unitCost: 0 },
        { id: 'p2', title: 'Null', unitCost: null },
      ],
      soldMovements: [],
    });

    const zero = report.rows.find((row) => row.productId === 'p1');
    const nul = report.rows.find((row) => row.productId === 'p2');
    expect(zero?.purchasePriceMinor).toBe(0);
    expect(zero?.costMissing).toBe(true);
    expect(zero?.estimated).toBe(false);
    expect(nul?.purchasePriceMinor).toBe(0);
    expect(nul?.costMissing).toBe(true);
    expect(nul?.estimated).toBe(false);
  });

  it('repli estimé sur le coût catalogue (unit_cost) quand aucun COGS figé', () => {
    // Pas de mouvement `sold` (COGS figé = 0) mais unit_cost connu → prix d'achat
    // = unit_cost × qté, marqué « estimée ». C'est le repli qui rend l'édition
    // inline du prix manquant utile (corriger → voir le bénéfice).
    const report = computeFinanceProductCostReport({
      expenses: [],
      orderLines: [{ orderId: 'o1', productId: 'p1', qty: 3, rawTitle: 'Sac' }],
      orders: [
        {
          deliveryFeeMinor: 0,
          id: 'o1',
          itemsSummary: [{ price: 5_000, quantity: 3, title: 'Sac' }],
          totalAmount: 15_000,
        },
      ],
      products: [{ id: 'p1', title: 'Sac', unitCost: 2_000 }],
      soldMovements: [],
    });

    const sac = report.rows.find((row) => row.productId === 'p1');
    expect(sac?.purchasePriceMinor).toBe(6_000); // 2000 × 3
    expect(sac?.estimated).toBe(true);
    expect(sac?.costMissing).toBe(false);
    expect(sac?.profitBeforeMinor).toBe(9_000); // 15000 − 6000
  });

  it('le COGS figé prime sur le coût catalogue (pas estimé)', () => {
    // unit_cost catalogue (9999) ne doit PAS écraser le COGS figé (1000) des `sold`.
    const report = computeFinanceProductCostReport({
      expenses: [],
      orderLines: [{ orderId: 'o1', productId: 'p1', qty: 2, rawTitle: 'Sac' }],
      orders: [
        {
          deliveryFeeMinor: 0,
          id: 'o1',
          itemsSummary: [{ price: 5_000, quantity: 2, title: 'Sac' }],
          totalAmount: 10_000,
        },
      ],
      products: [{ id: 'p1', title: 'Sac', unitCost: 9_999 }],
      soldMovements: [{ productId: 'p1', qty: 2, unitCost: 1_000 }],
    });

    const sac = report.rows.find((row) => row.productId === 'p1');
    expect(sac?.purchasePriceMinor).toBe(2_000); // COGS figé 1000 × 2, pas 9999
    expect(sac?.estimated).toBe(false);
  });

  it('n’explose pas sur un prix items_summary fractionnaire et arrondit le CA au minor', () => {
    // Reproduit le crash prod : BigInt(2536.06) → RangeError. Le prix jsonb est
    // fractionnaire (devise majeure Shopify), FCFA = entier → arrondi.
    const run = () =>
      computeFinanceProductCostReport({
        expenses: [],
        orderLines: [{ orderId: 'o1', productId: 'p1', qty: 2, rawTitle: 'Sac' }],
        orders: [
          {
            deliveryFeeMinor: 0,
            id: 'o1',
            itemsSummary: [{ price: 2_536.06, quantity: 2, title: 'Sac' }],
            totalAmount: 5_072.12,
          },
        ],
        products: [{ id: 'p1', title: 'Sac', unitCost: 5_000 }],
        soldMovements: [{ productId: 'p1', qty: 2, unitCost: 5_000 }],
      });

    expect(run).not.toThrow();
    const sac = run().rows.find((row) => row.productId === 'p1');
    // round(2536.06 × 2) = round(5072.12) = 5072
    expect(sac?.revenueMinor).toBe(5_072);
  });

  it('arrondit le coût total unitaire sur une division non exacte', () => {
    // purchase 4000 + ads 1073 + livraison 0 = coût total 5073 ; qty 2 → 5073/2
    // = 2536,5 → 2537 (half-up).
    const report = computeFinanceProductCostReport({
      expenses: [{ amountMinor: 1_073, categoryCode: 'ADS' }],
      orderLines: [{ orderId: 'o1', productId: 'p1', qty: 2, rawTitle: 'Sac' }],
      orders: [
        {
          deliveryFeeMinor: 0,
          id: 'o1',
          itemsSummary: [{ price: 6_000, quantity: 2, title: 'Sac' }],
          totalAmount: 12_000,
        },
      ],
      products: [{ id: 'p1', title: 'Sac', unitCost: 2_000 }],
      soldMovements: [{ productId: 'p1', qty: 2, unitCost: 2_000 }],
    });

    const sac = report.rows.find((row) => row.productId === 'p1');
    expect(sac?.purchasePriceMinor).toBe(4_000);
    expect(sac?.totalCostMinor).toBe(5_073);
    expect(sac?.totalCostUnitMinor).toBe(2_537); // (5073 + 1) / 2
    expect(sac?.purchaseUnitMinor).toBe(2_000);
  });
});
