import {
  computeReliabilityScore,
  tierFromScore,
  weightByRecency,
} from '@/lib/customers/reliability';
import { POPULATION_DELIVERY_SUCCESS } from '@/lib/customers/reliability-config';
import { describe, expect, it } from 'vitest';

function scoreInput(overrides: Partial<Parameters<typeof computeReliabilityScore>[0]> = {}) {
  return {
    attemptsWeighted: 0,
    cancelledCount: 0,
    confirmedWeighted: 0,
    deliveredCount: 0,
    deliveredWeighted: 0,
    noResponseWeighted: 0,
    orderCount: 0,
    refusedCount: 0,
    refusedWeighted: 0,
    ...overrides,
  };
}

describe('computeReliabilityScore', () => {
  it('starts deliveryScore at the population prior when no decision exists', () => {
    const result = computeReliabilityScore(scoreInput());

    expect(result.deliveryScore).toBeCloseTo(POPULATION_DELIVERY_SUCCESS, 5);
    expect(result.score).toBe(70);
  });

  it('does not collapse one refused order to zero or a risk tier', () => {
    const result = computeReliabilityScore(
      scoreInput({
        orderCount: 1,
        refusedCount: 1,
        refusedWeighted: 1,
      }),
    );

    expect(result.score).toBeGreaterThan(0);
    expect(result.tier).toBe('new');
  });

  it('marks customers with fewer than three decided orders as new', () => {
    const result = computeReliabilityScore(
      scoreInput({
        deliveredCount: 2,
        deliveredWeighted: 2,
        orderCount: 2,
      }),
    );

    expect(result.decided).toBe(2);
    expect(result.tier).toBe('new');
  });

  it('flags customers who confirm but refuse often at delivery', () => {
    const result = computeReliabilityScore(
      scoreInput({
        attemptsWeighted: 12,
        confirmedWeighted: 12,
        orderCount: 3,
        refusedCount: 3,
        refusedWeighted: 3,
      }),
    );

    expect(result.deliveryScore).toBeLessThan(0.5);
    expect(result.score).toBeLessThan(75);
    expect(result.flags.confirmsThenRefuses).toBe(true);
  });

  it('weights a two-year-old refusal less than a recent delivery', () => {
    const reference = new Date('2026-06-01T00:00:00Z');
    const recentDelivery = weightByRecency(new Date('2026-05-31T00:00:00Z'), reference);
    const oldRefusal = weightByRecency(new Date('2024-06-01T00:00:00Z'), reference);

    expect(oldRefusal).toBeLessThan(recentDelivery);
  });

  it('ignores confirmation term when there are no call attempts', () => {
    const result = computeReliabilityScore(
      scoreInput({
        deliveredCount: 4,
        deliveredWeighted: 4,
        orderCount: 4,
      }),
    );

    expect(result.confirmScore).toBeNull();
    expect(result.score).toBe(Math.round(100 * result.deliveryScore));
  });
});

describe('tierFromScore', () => {
  it.each([
    [75, 'reliable'],
    [74, 'watch'],
    [50, 'watch'],
    [49, 'risk'],
  ] as const)('maps score %s to %s at the threshold', (score, expectedTier) => {
    expect(tierFromScore(score, 5)).toBe(expectedTier);
  });
});
