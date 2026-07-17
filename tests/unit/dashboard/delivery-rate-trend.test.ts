import { selectMatureCohortPoints } from '@/components/dashboard/delivery-rate-trend';
import type { LossAnalyticsTrendPoint } from '@/lib/loss-analytics/metrics';
import { describe, expect, it } from 'vitest';

function point(overrides: Partial<LossAnalyticsTrendPoint>): LossAnalyticsTrendPoint {
  return {
    cancellationCount: 0,
    cohortDeliveryRate: 0,
    date: '2026-07-10',
    deliveredCount: 0,
    deliveredOrders: 0,
    isMature: true,
    returnCount: 0,
    rtoCount: 0,
    rtoDenominator: 0,
    rtoRate: 0,
    totalOrders: 0,
    ...overrides,
  };
}

describe('selectMatureCohortPoints', () => {
  it('ne trace aucun point pour les cohortes encore en maturation', () => {
    const trends = [
      point({ date: '2026-07-08', isMature: true, cohortDeliveryRate: 0.8 }),
      point({ date: '2026-07-09', isMature: false, cohortDeliveryRate: 0.1 }),
      point({ date: '2026-07-10', isMature: false, cohortDeliveryRate: 0 }),
    ];

    const result = selectMatureCohortPoints(trends);

    expect(result).toHaveLength(1);
    expect(result[0]?.date).toBe('2026-07-08');
  });

  it('fait apparaître un point en trait plein dès que son seuil de maturité est atteint', () => {
    const stillImmature = [point({ date: '2026-07-09', isMature: false, cohortDeliveryRate: 0.4 })];
    expect(selectMatureCohortPoints(stillImmature)).toHaveLength(0);

    const nowMature = [point({ date: '2026-07-09', isMature: true, cohortDeliveryRate: 0.4 })];
    const result = selectMatureCohortPoints(nowMature);
    expect(result).toHaveLength(1);
    expect(result[0]?.matureRate).toBe(0.4);
  });

  it("ne modifie pas l'ordre ni les autres champs des points matures", () => {
    const trends = [
      point({ date: '2026-07-06', isMature: true, cohortDeliveryRate: 0.5, totalOrders: 10 }),
      point({ date: '2026-07-07', isMature: true, cohortDeliveryRate: 0.6, totalOrders: 12 }),
    ];

    const result = selectMatureCohortPoints(trends);

    expect(result.map((p) => p.date)).toEqual(['2026-07-06', '2026-07-07']);
    expect(result[1]?.totalOrders).toBe(12);
  });

  it('retourne un tableau vide si toutes les cohortes sont immatures', () => {
    const trends = [
      point({ date: '2026-07-09', isMature: false }),
      point({ date: '2026-07-10', isMature: false }),
    ];

    expect(selectMatureCohortPoints(trends)).toEqual([]);
  });
});
