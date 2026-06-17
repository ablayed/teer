import { computeFinanceDriverCostReport } from '@/lib/finance/driver-cost';
import { describe, expect, it } from 'vitest';

describe('computeFinanceDriverCostReport', () => {
  it('agrège le COGS figé des mouvements sold par livreur', () => {
    const report = computeFinanceDriverCostReport({
      drivers: [
        { fullName: 'Awa Diop', id: 'driver-a' },
        { fullName: 'Moussa Fall', id: 'driver-b' },
      ],
      orders: [
        { assignedDriverId: 'driver-a', deliveryFeeMinor: 1_000, totalAmount: 21_000 },
        { assignedDriverId: 'driver-b', deliveryFeeMinor: 500, totalAmount: 10_500 },
      ],
      soldMovements: [
        { driverId: 'driver-a', qty: 2, unitCost: 5_000 },
        { driverId: 'driver-a', qty: 1, unitCost: 3_000 },
        { driverId: 'driver-b', qty: 1, unitCost: 4_000 },
        { driverId: null, qty: 1, unitCost: 9_000 },
      ],
    });

    expect(report.totalCogsMinor).toBe(17_000);
    expect(report.totalQtySold).toBe(4);
    expect(report.rows[0]).toMatchObject({
      cogsMinor: 13_000,
      driverId: 'driver-a',
      marginMinor: 7_000,
      qtySold: 3,
      revenueMinor: 20_000,
      title: 'Awa Diop',
      unitCogsMinor: 4_333,
    });
    expect(report.rows[1]).toMatchObject({
      cogsMinor: 4_000,
      driverId: 'driver-b',
      marginMinor: 6_000,
      qtySold: 1,
      revenueMinor: 10_000,
    });
  });

  it('arrondit un total_amount fractionnaire (numeric) sans lever BigInt(float)', () => {
    // Reproduit le crash prod : orders.total_amount est `numeric` → BigInt(2536.06)
    // lève un RangeError. FCFA = entier → arrondi par commande puis somme.
    const run = () =>
      computeFinanceDriverCostReport({
        drivers: [{ fullName: 'Awa Diop', id: 'driver-a' }],
        orders: [
          { assignedDriverId: 'driver-a', deliveryFeeMinor: 0, totalAmount: 2_536.06 },
          { assignedDriverId: 'driver-a', deliveryFeeMinor: 0, totalAmount: 7_609.34 },
        ],
        // 2 mouvements de coûts différents → unitCogs = 12146/3 non exact.
        soldMovements: [
          { driverId: 'driver-a', qty: 2, unitCost: 5_073 },
          { driverId: 'driver-a', qty: 1, unitCost: 2_000 },
        ],
      });

    expect(run).not.toThrow();
    const report = run();
    // round(2536.06) + round(7609.34) = 2536 + 7609 = 10145
    expect(report.rows[0].revenueMinor).toBe(10_145);
    expect(report.rows[0].cogsMinor).toBe(12_146);
    // 12146 / 3 = 4048,67 → (12146 + 1) / 3 = 4049
    expect(report.rows[0].unitCogsMinor).toBe(4_049);
    // marge = CA 10145 − COGS 12146 = −2001
    expect(report.rows[0].marginMinor).toBe(-2_001);
  });
});
