import {
  type Revenue30dOrder,
  aggregateRevenue30d,
  revenue30dLowerBound,
} from '@/lib/dashboard/revenue-30d';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TODAY = new Date('2026-07-03T12:00:00.000Z');

function order(overrides: Partial<Revenue30dOrder>): Revenue30dOrder {
  return {
    created_at: '2026-06-20T09:00:00.000Z',
    created_at_shopify: null,
    currency: 'XOF',
    total_amount: 1_000,
    ...overrides,
  };
}

describe('aggregateRevenue30d', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TODAY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('bucket une commande sur son jour d’affichage (created_at_shopify prioritaire sur created_at)', () => {
    const result = aggregateRevenue30d([
      order({
        created_at: '2026-06-21T00:00:00.000Z',
        created_at_shopify: '2026-06-15T08:00:00.000Z',
        total_amount: 5_000,
      }),
    ]);

    const point = result.points.find((p) => p.date === '2026-06-15');

    expect(point?.value).toBe(5_000);
  });

  it('retombe sur created_at quand created_at_shopify est absent', () => {
    const result = aggregateRevenue30d([
      order({
        created_at: '2026-06-20T09:00:00.000Z',
        created_at_shopify: null,
        total_amount: 7_000,
      }),
    ]);

    const point = result.points.find((p) => p.date === '2026-06-20');

    expect(point?.value).toBe(7_000);
  });

  it('somme plusieurs commandes retombant sur le même jour', () => {
    const result = aggregateRevenue30d([
      order({ created_at_shopify: '2026-06-20T10:00:00.000Z', total_amount: 1_000 }),
      order({ created_at_shopify: '2026-06-20T18:00:00.000Z', total_amount: 2_000 }),
    ]);

    const point = result.points.find((p) => p.date === '2026-06-20');

    expect(point?.value).toBe(3_000);
  });

  it('ignore une commande hors fenêtre 30 jours (avant le premier point)', () => {
    const result = aggregateRevenue30d([order({ created_at_shopify: '2026-01-01T00:00:00.000Z' })]);

    const total = result.points.reduce((sum, p) => sum + p.value, 0);

    expect(total).toBe(0);
  });

  it('couvre exactement les 30 derniers jours, du plus ancien au jour courant', () => {
    const result = aggregateRevenue30d([]);

    expect(result.points).toHaveLength(30);
    expect(result.points[0]?.date).toBe('2026-06-04');
    expect(result.points[29]?.date).toBe('2026-07-03');
  });

  it('reprend la devise de la première commande rencontrée', () => {
    const result = aggregateRevenue30d([order({ currency: 'usd' })]);

    expect(result.currency).toBe('USD');
  });
});

describe('revenue30dLowerBound', () => {
  it('borne 89 jours avant aujourd’hui (fenêtre 30j + marge 60j)', () => {
    const bound = new Date(revenue30dLowerBound(TODAY));
    const expected = new Date('2026-04-05T00:00:00.000Z');

    expect(bound.toISOString()).toBe(expected.toISOString());
  });
});
