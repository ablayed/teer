import {
  type LossAnalyticsAuditLog,
  type LossAnalyticsCustomer,
  type LossAnalyticsDriver,
  type LossAnalyticsOrder,
  type LossAnalyticsOrderLine,
  type LossAnalyticsReliability,
  computeLossAnalytics,
} from '@/lib/loss-analytics/metrics';
import { describe, expect, it } from 'vitest';

function order(overrides: Partial<LossAnalyticsOrder>): LossAnalyticsOrder {
  return {
    assignedDriverId: null,
    cancelReason: null,
    createdAt: '2026-06-01T09:00:00.000Z',
    customerId: 'customer-1',
    deliveryState: 'unassigned',
    id: 'order-1',
    orderState: 'open',
    source: 'manual',
    ...overrides,
  };
}

function audit(overrides: Partial<LossAnalyticsAuditLog>): LossAnalyticsAuditLog {
  return {
    createdAt: '2026-06-02T12:00:00.000Z',
    payload: {
      nextDimensions: {
        delivery_state: 'failed',
        order_state: 'cancelled',
      },
      priorDimensions: {
        delivery_state: 'out_for_delivery',
        order_state: 'open',
      },
    },
    resourceId: 'order-1',
    ...overrides,
  };
}

function line(overrides: Partial<LossAnalyticsOrderLine>): LossAnalyticsOrderLine {
  return {
    matchStatus: 'matched',
    orderId: 'order-1',
    productId: 'product-1',
    qty: 1,
    rawSku: 'SKU-1',
    rawTitle: 'Produit 1',
    ...overrides,
  };
}

function customer(overrides: Partial<LossAnalyticsCustomer>): LossAnalyticsCustomer {
  return {
    address: { region: 'Dakar Plateau' },
    fullName: 'Awa',
    id: 'customer-1',
    shippingAddress: { address1: 'Almadies', city: 'Dakar' },
    ...overrides,
  };
}

function driver(overrides: Partial<LossAnalyticsDriver>): LossAnalyticsDriver {
  return {
    fullName: 'Moussa',
    id: 'driver-1',
    ...overrides,
  };
}

function reliability(overrides: Partial<LossAnalyticsReliability>): LossAnalyticsReliability {
  return {
    customerId: 'customer-1',
    fullName: 'Awa',
    orderCount: 3,
    refusedCount: 2,
    score: 42,
    tier: 'risk',
    ...overrides,
  };
}

describe('computeLossAnalytics', () => {
  it('computes summary rates from the current order cohort', () => {
    const result = computeLossAnalytics({
      auditLogs: [
        audit({
          payload: {
            nextDimensions: { delivery_state: 'unassigned', order_state: 'cancelled' },
            priorDimensions: { delivery_state: 'scheduled', order_state: 'open' },
          },
          resourceId: 'order-cancel',
        }),
        audit({
          payload: {
            nextDimensions: { delivery_state: 'failed', order_state: 'cancelled' },
            priorDimensions: { delivery_state: 'out_for_delivery', order_state: 'open' },
          },
          resourceId: 'order-rto',
        }),
        audit({
          payload: {
            nextDimensions: { delivery_state: 'delivered', order_state: 'completed' },
            priorDimensions: { delivery_state: 'assigned', order_state: 'open' },
          },
          resourceId: 'order-return',
        }),
        audit({
          createdAt: '2026-06-03T10:00:00.000Z',
          payload: {
            nextDimensions: { delivery_state: 'returned', order_state: 'returned' },
            priorDimensions: { delivery_state: 'delivered', order_state: 'completed' },
          },
          resourceId: 'order-return',
        }),
      ],
      customers: [
        customer({ id: 'customer-cancel' }),
        customer({ id: 'customer-rto' }),
        customer({ id: 'customer-return' }),
      ],
      drivers: [],
      fromISO: '2026-06-01T00:00:00.000Z',
      orderLines: [],
      orders: [
        order({
          customerId: 'customer-cancel',
          deliveryState: 'unassigned',
          id: 'order-cancel',
          orderState: 'cancelled',
        }),
        order({
          customerId: 'customer-rto',
          deliveryState: 'failed',
          id: 'order-rto',
          orderState: 'cancelled',
        }),
        order({
          customerId: 'customer-return',
          deliveryState: 'returned',
          id: 'order-return',
          orderState: 'returned',
        }),
        order({
          customerId: 'customer-delivered',
          deliveryState: 'delivered',
          id: 'order-delivered',
          orderState: 'completed',
        }),
      ],
      reliability: [],
      toISO: '2026-06-07T23:59:59.999Z',
    });

    expect(result.summary.totalOrders).toBe(4);
    expect(result.summary.cancellationCount).toBe(1);
    expect(result.summary.cancellationRate).toBeCloseTo(0.25, 5);
    expect(result.summary.returnCount).toBe(1);
    expect(result.summary.returnRate).toBeCloseTo(0.5, 5);
    expect(result.summary.rtoCount).toBe(1);
    expect(result.summary.rtoDenominator).toBe(2);
    expect(result.summary.rtoRate).toBeCloseTo(0.5, 5);
  });

  it('builds source scorecards and trends from the retained definitions', () => {
    const result = computeLossAnalytics({
      auditLogs: [
        audit({
          createdAt: '2026-06-02T08:00:00.000Z',
          payload: {
            nextDimensions: { delivery_state: 'failed', order_state: 'cancelled' },
            priorDimensions: { delivery_state: 'out_for_delivery', order_state: 'open' },
          },
          resourceId: 'order-shopify-rto',
        }),
        audit({
          createdAt: '2026-06-02T09:00:00.000Z',
          payload: {
            nextDimensions: { delivery_state: 'delivered', order_state: 'completed' },
            priorDimensions: { delivery_state: 'assigned', order_state: 'open' },
          },
          resourceId: 'order-manual-delivered',
        }),
        audit({
          createdAt: '2026-06-03T10:00:00.000Z',
          payload: {
            nextDimensions: { delivery_state: 'unassigned', order_state: 'cancelled' },
            priorDimensions: { delivery_state: 'scheduled', order_state: 'open' },
          },
          resourceId: 'order-shopify-cancel',
        }),
      ],
      customers: [customer({ id: 'customer-1' })],
      drivers: [],
      fromISO: '2026-06-01T00:00:00.000Z',
      orderLines: [],
      orders: [
        order({
          deliveryState: 'failed',
          id: 'order-shopify-rto',
          source: 'shopify',
        }),
        order({
          deliveryState: 'delivered',
          id: 'order-manual-delivered',
          orderState: 'completed',
          source: 'manual',
        }),
        order({
          deliveryState: 'unassigned',
          id: 'order-shopify-cancel',
          orderState: 'cancelled',
          source: 'shopify',
        }),
      ],
      reliability: [],
      toISO: '2026-06-04T23:59:59.999Z',
    });

    expect(result.sourceScorecard).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'shopify',
          totalOrders: 2,
          cancellationCount: 1,
          rtoCount: 1,
          outcomeOrders: 1,
          rtoRate: 1,
        }),
        expect.objectContaining({
          source: 'manual',
          totalOrders: 1,
          deliveredCount: 1,
          completionRate: 1,
        }),
      ]),
    );

    expect(result.trends.find((point) => point.date === '2026-06-02')).toMatchObject({
      deliveredCount: 1,
      rtoCount: 1,
      rtoDenominator: 2,
      rtoRate: 0.5,
    });
    expect(result.trends.find((point) => point.date === '2026-06-03')).toMatchObject({
      cancellationCount: 1,
    });
  });

  it('aggregates product, zone, driver, reason and repeated refusers', () => {
    const result = computeLossAnalytics({
      auditLogs: [
        audit({
          payload: {
            nextDimensions: { delivery_state: 'failed', order_state: 'cancelled' },
            priorDimensions: { delivery_state: 'out_for_delivery', order_state: 'open' },
          },
          resourceId: 'order-rto',
        }),
      ],
      customers: [customer({ id: 'customer-rto', address: { region: 'Guediawaye' } })],
      drivers: [driver({ id: 'driver-rto', fullName: 'Livreur RTO' })],
      fromISO: '2026-06-01T00:00:00.000Z',
      orderLines: [
        line({
          orderId: 'order-rto',
          productId: 'product-rto',
          qty: 2,
          rawSku: 'RTO-1',
          rawTitle: 'Sandale RTO',
        }),
      ],
      orders: [
        order({
          assignedDriverId: 'driver-rto',
          cancelReason: 'refused',
          customerId: 'customer-rto',
          deliveryState: 'failed',
          id: 'order-rto',
          source: 'shopify',
        }),
      ],
      reliability: [
        reliability({ customerId: 'customer-rto', fullName: 'Client Refuseur', refusedCount: 3 }),
        reliability({ customerId: 'customer-safe', fullName: 'Client Safe', refusedCount: 1 }),
      ],
      toISO: '2026-06-07T23:59:59.999Z',
    });

    expect(result.productLosses[0]).toMatchObject({
      name: 'Sandale RTO',
      rtoOrders: 1,
      rtoUnits: 2,
      sku: 'RTO-1',
    });
    expect(result.zoneLosses[0]).toMatchObject({
      label: 'Guediawaye',
      rtoOrders: 1,
    });
    expect(result.driverPerformance[0]).toMatchObject({
      driverId: 'driver-rto',
      driverName: 'Livreur RTO',
      rtoOrders: 1,
      rtoRate: 1,
    });
    expect(result.reasonBreakdown).toEqual([{ count: 1, reason: 'refused' }]);
    expect(result.repeatedRefusers).toEqual([
      expect.objectContaining({
        customerId: 'customer-rto',
        fullName: 'Client Refuseur',
        refusedCount: 3,
      }),
    ]);
  });

  it('counts failed as RTO only and returned-after-delivered as return only', () => {
    const result = computeLossAnalytics({
      auditLogs: [
        audit({
          createdAt: '2026-06-02T08:00:00.000Z',
          payload: {
            nextDimensions: { delivery_state: 'failed', order_state: 'cancelled' },
            priorDimensions: { delivery_state: 'out_for_delivery', order_state: 'open' },
          },
          resourceId: 'order-failed',
        }),
        audit({
          createdAt: '2026-06-02T09:00:00.000Z',
          payload: {
            nextDimensions: { delivery_state: 'delivered', order_state: 'completed' },
            priorDimensions: { delivery_state: 'assigned', order_state: 'open' },
          },
          resourceId: 'order-returned',
        }),
        audit({
          createdAt: '2026-06-03T09:00:00.000Z',
          payload: {
            nextDimensions: { delivery_state: 'returned', order_state: 'returned' },
            priorDimensions: { delivery_state: 'delivered', order_state: 'completed' },
          },
          resourceId: 'order-returned',
        }),
      ],
      customers: [customer({ id: 'customer-failed' }), customer({ id: 'customer-returned' })],
      drivers: [],
      fromISO: '2026-06-01T00:00:00.000Z',
      orderLines: [],
      orders: [
        order({
          customerId: 'customer-failed',
          deliveryState: 'failed',
          id: 'order-failed',
          orderState: 'cancelled',
        }),
        order({
          customerId: 'customer-returned',
          deliveryState: 'returned',
          id: 'order-returned',
          orderState: 'returned',
        }),
      ],
      reliability: [],
      toISO: '2026-06-04T23:59:59.999Z',
    });

    expect(result.summary.rtoCount).toBe(1);
    expect(result.summary.returnCount).toBe(1);
    expect(result.summary.rtoDenominator).toBe(1);
    expect(result.summary.returnRate).toBe(1);
    expect(result.summary.rtoRate).toBe(1);
  });

  it('ignores returned without prior delivered for return counting', () => {
    const result = computeLossAnalytics({
      auditLogs: [
        audit({
          createdAt: '2026-06-03T09:00:00.000Z',
          payload: {
            nextDimensions: { delivery_state: 'returned', order_state: 'returned' },
            priorDimensions: { delivery_state: 'assigned', order_state: 'open' },
          },
          resourceId: 'order-returned-without-delivered',
        }),
      ],
      customers: [customer({ id: 'customer-returned-without-delivered' })],
      drivers: [],
      fromISO: '2026-06-01T00:00:00.000Z',
      orderLines: [],
      orders: [
        order({
          customerId: 'customer-returned-without-delivered',
          deliveryState: 'returned',
          id: 'order-returned-without-delivered',
          orderState: 'returned',
        }),
      ],
      reliability: [],
      toISO: '2026-06-04T23:59:59.999Z',
    });

    expect(result.summary.returnCount).toBe(0);
    expect(result.summary.rtoCount).toBe(0);
    expect(result.summary.returnRate).toBe(0);
    expect(result.summary.rtoRate).toBe(0);
  });
});
