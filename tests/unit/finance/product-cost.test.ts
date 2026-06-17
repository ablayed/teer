import { computeFinanceProductCostReport } from '@/lib/finance/product-cost';
import { describe, expect, it } from 'vitest';

describe('computeFinanceProductCostReport', () => {
  it('alloue publicité par CA, livraison par article, et borne les lots reçus à la période', () => {
    const report = computeFinanceProductCostReport({
      expenses: [{ amountMinor: 3_000, categoryCode: 'ADS' }],
      fromIso: '2026-06-01T00:00:00.000Z',
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
        { id: 'p1', title: 'Sac' },
        { id: 'p2', title: 'Ceinture' },
      ],
      purchaseLotLines: [
        { landedTotalValue: 12_000, productId: 'p1', purchaseLotId: 'lot-in', qty: 2 },
        { landedTotalValue: 20_000, productId: 'p1', purchaseLotId: 'lot-out', qty: 2 },
        { landedTotalValue: 2_000, productId: 'p2', purchaseLotId: 'lot-in', qty: 1 },
      ],
      purchaseLots: [
        { id: 'lot-in', receivedAt: '2026-06-10T08:00:00.000Z', status: 'received' },
        { id: 'lot-out', receivedAt: '2026-05-31T08:00:00.000Z', status: 'received' },
      ],
      soldMovements: [
        { productId: 'p1', qty: 2, unitCost: 5_000 },
        { productId: 'p2', qty: 1, unitCost: 2_000 },
      ],
      toIso: '2026-06-30T23:59:59.999Z',
    });

    const sac = report.rows.find((row) => row.productId === 'p1');
    const ceinture = report.rows.find((row) => row.productId === 'p2');

    expect(sac).toMatchObject({
      adsAllocatedMinor: 2_400,
      deliveryAllocatedMinor: 600,
      landedReceivedMinor: 12_000,
      officialUnitCostMinor: 5_000,
      pilotUnitCostMinor: 7_500,
      qtySold: 2,
      revenueMinor: 20_000,
    });
    expect(ceinture).toMatchObject({
      adsAllocatedMinor: 600,
      deliveryAllocatedMinor: 300,
      landedReceivedMinor: 2_000,
      pilotUnitCostMinor: 2_900,
      qtySold: 1,
      revenueMinor: 5_000,
    });
    expect(report.totalAdsAllocatedMinor).toBe(3_000);
    expect(report.deliveryAllocatedMinor).toBe(900);
    expect(report.unallocatedDeliveryMinor).toBe(0);
    expect(report.totalLandedReceivedMinor).toBe(14_000);
  });

  it('n’explose pas sur un prix items_summary fractionnaire et arrondit le CA au minor', () => {
    // Reproduit le crash prod : BigInt(2536.06) → RangeError. Le prix jsonb est
    // fractionnaire (devise majeure Shopify), FCFA = entier → arrondi.
    const run = () =>
      computeFinanceProductCostReport({
        expenses: [],
        fromIso: '2026-06-01T00:00:00.000Z',
        orderLines: [{ orderId: 'o1', productId: 'p1', qty: 2, rawTitle: 'Sac' }],
        orders: [
          {
            deliveryFeeMinor: 0,
            id: 'o1',
            itemsSummary: [{ price: 2_536.06, quantity: 2, title: 'Sac' }],
            totalAmount: 5_072.12,
          },
        ],
        products: [{ id: 'p1', title: 'Sac' }],
        purchaseLotLines: [],
        purchaseLots: [],
        soldMovements: [{ productId: 'p1', qty: 2, unitCost: 5_000 }],
        toIso: '2026-06-30T23:59:59.999Z',
      });

    expect(run).not.toThrow();
    const sac = run().rows.find((row) => row.productId === 'p1');
    // round(2536.06 × 2) = round(5072.12) = 5072
    expect(sac?.revenueMinor).toBe(5_072);
  });

  it('arrondit le coût de revient unitaire (pilotage) sur une division non exacte', () => {
    // pilotCost = landed 5073 + ads 0 + livraison 0 ; qty 2 → 5073/2 = 2536,5 → 2537.
    const report = computeFinanceProductCostReport({
      expenses: [],
      fromIso: '2026-06-01T00:00:00.000Z',
      orderLines: [{ orderId: 'o1', productId: 'p1', qty: 2, rawTitle: 'Sac' }],
      orders: [
        {
          deliveryFeeMinor: 0,
          id: 'o1',
          itemsSummary: [{ price: 6_000, quantity: 2, title: 'Sac' }],
          totalAmount: 12_000,
        },
      ],
      products: [{ id: 'p1', title: 'Sac' }],
      purchaseLotLines: [
        { landedTotalValue: 5_073, productId: 'p1', purchaseLotId: 'lot', qty: 2 },
      ],
      purchaseLots: [{ id: 'lot', receivedAt: '2026-06-10T08:00:00.000Z', status: 'received' }],
      soldMovements: [{ productId: 'p1', qty: 2, unitCost: 3_000 }],
      toIso: '2026-06-30T23:59:59.999Z',
    });

    const sac = report.rows.find((row) => row.productId === 'p1');
    expect(sac?.pilotUnitCostMinor).toBe(2_537); // (5073 + 1) / 2
    expect(sac?.officialUnitCostMinor).toBe(3_000);
  });
});
