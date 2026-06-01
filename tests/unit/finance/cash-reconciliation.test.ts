import {
  type OutstandingOrder,
  agingBucket,
  allocateOldestFirst,
  amountToMinor,
  cashCollectableMinor,
  idempotentSettlementResult,
  outstandingMinorByDriver,
  remainingCashMinor,
  shortfallMinor,
  totalOutstandingMinor,
} from '@/lib/finance/cash';
import { describe, expect, it } from 'vitest';

describe('cashCollectableMinor', () => {
  it('treats ESPECES as fully collectable by the driver', () => {
    expect(
      cashCollectableMinor({
        paymentChannel: 'ESPECES',
        totalAmount: 12_500,
      }),
    ).toBe(12_500);
  });

  it.each(['WAVE', 'ORANGE_MONEY', 'FREE_MONEY'])(
    'treats %s as non-cash collectable',
    (paymentChannel) => {
      expect(
        cashCollectableMinor({
          paymentChannel,
          totalAmount: 12_500,
        }),
      ).toBe(0);
    },
  );

  it('treats INCONNU as cash collectable until correction', () => {
    expect(
      cashCollectableMinor({
        paymentChannel: 'INCONNU',
        totalAmount: 12_500,
      }),
    ).toBe(12_500);
  });

  it('rounds numeric order totals to whole XOF minor units', () => {
    expect(amountToMinor(1000.49)).toBe(1000);
    expect(amountToMinor(1000.5)).toBe(1001);
  });
});

describe('allocateOldestFirst', () => {
  const orders: OutstandingOrder[] = [
    { deliveredAt: '2026-01-03T00:00:00Z', orderId: 'order-c', outstandingMinor: 3000 },
    { deliveredAt: '2026-01-01T00:00:00Z', orderId: 'order-a', outstandingMinor: 2000 },
    { deliveredAt: '2026-01-02T00:00:00Z', orderId: 'order-b', outstandingMinor: 2500 },
  ];

  it('allocates partial settlements oldest first', () => {
    const result = allocateOldestFirst(orders, 3500);

    expect(result.allocations).toEqual([
      { orderId: 'order-a', allocatedMinor: 2000 },
      { orderId: 'order-b', allocatedMinor: 1500 },
    ]);
    expect(result.allocatedMinor).toBe(3500);
    expect(result.remainingMinor).toBe(0);
  });

  it('leaves unpaid cash outstanding after a partial settlement', () => {
    const result = allocateOldestFirst(orders, 3500);
    const allocatedByOrder = new Map(
      result.allocations.map((allocation) => [allocation.orderId, allocation.allocatedMinor]),
    );
    const outstandingAfterSettlement = orders.map((order) => ({
      ...order,
      outstandingMinor: remainingCashMinor({
        cashCollectableMinor: order.outstandingMinor,
        allocatedMinor: allocatedByOrder.get(order.orderId) ?? 0,
      }),
    }));

    expect(totalOutstandingMinor(outstandingAfterSettlement)).toBe(4000);
  });
});

describe('shortfallMinor', () => {
  it('returns the exact generated shortfall amount when received is lower than expected', () => {
    expect(shortfallMinor(12_500, 10_000)).toBe(2500);
  });

  it('does not create a negative shortfall on overpayment', () => {
    expect(shortfallMinor(10_000, 12_000)).toBe(0);
  });
});

describe('idempotentSettlementResult', () => {
  it('returns the original settlement for the same clientRequestId', () => {
    const existing = new Map([['request-a', { settlementId: 'settlement-a' }]]);

    expect(idempotentSettlementResult(existing, 'request-a')).toEqual({
      idempotent: true,
      settlement: { settlementId: 'settlement-a' },
    });
  });

  it('marks new clientRequestId as non-idempotent', () => {
    expect(idempotentSettlementResult(new Map(), 'request-a')).toEqual({ idempotent: false });
  });
});

describe('agingBucket', () => {
  const now = new Date('2026-06-01T12:00:00Z');

  it('buckets 0.9 days in <1d', () => {
    expect(agingBucket(new Date(now.getTime() - 0.9 * 86_400_000), now)).toBe('lt1d');
  });

  it('buckets exactly 1.0 days in 1-3d', () => {
    expect(agingBucket(new Date(now.getTime() - 1.0 * 86_400_000), now)).toBe('1_3d');
  });

  it('buckets 3.01 days in >3d', () => {
    expect(agingBucket(new Date(now.getTime() - 3.01 * 86_400_000), now)).toBe('gt3d');
  });
});

describe('cash invariant', () => {
  it('keeps sum by driver equal to global cash outstanding over a deterministic sequence', () => {
    const orders: OutstandingOrder[] = Array.from({ length: 24 }).map((_, index) => ({
      deliveredAt: `2026-01-${String((index % 9) + 1).padStart(2, '0')}T00:00:00Z`,
      driverId: index % 2 === 0 ? 'driver-a' : 'driver-b',
      orderId: `order-${index}`,
      outstandingMinor: 1000 + index * 137,
    }));
    const settlementA = allocateOldestFirst(
      orders.filter((order) => order.driverId === 'driver-a'),
      11_000,
    );
    const settlementB = allocateOldestFirst(
      orders.filter((order) => order.driverId === 'driver-b'),
      8_000,
    );
    const allocated = new Map<string, number>();

    for (const allocation of [...settlementA.allocations, ...settlementB.allocations]) {
      allocated.set(allocation.orderId, allocation.allocatedMinor);
    }

    const outstanding = orders.map((order) => ({
      ...order,
      outstandingMinor: remainingCashMinor({
        cashCollectableMinor: order.outstandingMinor,
        allocatedMinor: allocated.get(order.orderId) ?? 0,
      }),
    }));
    const byDriver = outstandingMinorByDriver(outstanding);
    const sumByDriver = [...byDriver.values()].reduce((total, value) => total + value, 0);

    expect(sumByDriver).toBe(totalOutstandingMinor(outstanding));
  });
});
