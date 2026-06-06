import {
  type ChartOrder,
  aggregateFunnel,
  aggregateShopRevenue,
  bucketRevenueByDay,
} from '@/lib/finance/charts';
import { describe, expect, it } from 'vitest';

describe('bucketRevenueByDay', () => {
  it('ventile le CA encaissé par jour sur la fenêtre (0 si rien)', () => {
    const orders: ChartOrder[] = [
      { totalAmount: 10_000, cashCollectedAt: '2026-06-01T09:00:00Z', shopId: 's1' },
      { totalAmount: 5_000, cashCollectedAt: '2026-06-01T18:00:00Z', shopId: 's1' },
      { totalAmount: 8_000, cashCollectedAt: '2026-06-03T12:00:00Z', shopId: 's2' },
    ];
    const points = bucketRevenueByDay(orders, '2026-06-01T00:00:00Z', '2026-06-03T23:59:59Z');
    expect(points).toEqual([
      { date: '2026-06-01', value: 15_000 },
      { date: '2026-06-02', value: 0 },
      { date: '2026-06-03', value: 8_000 },
    ]);
  });

  it('ignore les commandes hors période et sans encaissement', () => {
    const orders: ChartOrder[] = [
      { totalAmount: 9_000, cashCollectedAt: '2026-05-30T09:00:00Z', shopId: 's1' }, // avant
      { totalAmount: 7_000, cashCollectedAt: null, shopId: 's1' }, // non encaissée
    ];
    const points = bucketRevenueByDay(orders, '2026-06-01T00:00:00Z', '2026-06-01T23:59:59Z');
    expect(points).toEqual([{ date: '2026-06-01', value: 0 }]);
  });

  it('une période « aujourd’hui » ne produit qu’un seul bucket', () => {
    const points = bucketRevenueByDay([], '2026-06-06T08:00:00Z', '2026-06-06T20:00:00Z');
    expect(points).toHaveLength(1);
  });
});

describe('aggregateShopRevenue', () => {
  const names = new Map([
    ['s1', 'boutique-a.myshopify.com'],
    ['s2', 'boutique-b.myshopify.com'],
  ]);

  it('regroupe le CA encaissé par boutique, trié décroissant', () => {
    const orders: ChartOrder[] = [
      { totalAmount: 10_000, cashCollectedAt: '2026-06-01T09:00:00Z', shopId: 's1' },
      { totalAmount: 30_000, cashCollectedAt: '2026-06-02T09:00:00Z', shopId: 's2' },
      { totalAmount: 5_000, cashCollectedAt: '2026-06-02T10:00:00Z', shopId: 's1' },
    ];
    expect(aggregateShopRevenue(orders, names)).toEqual([
      { name: 'boutique-b.myshopify.com', revenue: 30_000 },
      { name: 'boutique-a.myshopify.com', revenue: 15_000 },
    ]);
  });

  it('ignore les commandes sans boutique ou non encaissées', () => {
    const orders: ChartOrder[] = [
      { totalAmount: 10_000, cashCollectedAt: '2026-06-01T09:00:00Z', shopId: null },
      { totalAmount: 10_000, cashCollectedAt: null, shopId: 's1' },
    ];
    expect(aggregateShopRevenue(orders, names)).toEqual([]);
  });
});

describe('aggregateFunnel', () => {
  const statuses = ['A_APPELER', 'CONFIRMEE', 'LIVREE'] as const;

  it('compte par statut dans l’ordre fourni, statuts absents à 0', () => {
    expect(aggregateFunnel(['A_APPELER', 'LIVREE', 'LIVREE', 'INCONNU'], statuses)).toEqual([
      { status: 'A_APPELER', count: 1 },
      { status: 'CONFIRMEE', count: 0 },
      { status: 'LIVREE', count: 2 },
    ]);
  });
});
