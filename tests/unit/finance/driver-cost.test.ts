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
});
