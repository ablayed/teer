import {
  CONFIRMATION_PSEUDO_CALLS,
  DELIVERY_PSEUDO_ORDERS,
  HALF_LIFE_DAYS,
  MIN_DECIDED,
  POPULATION_CONFIRMATION_SUCCESS,
  POPULATION_DELIVERY_SUCCESS,
  PROVISIONAL_MAX,
  TIER_FIABLE,
  TIER_SURVEILLER,
} from '@/lib/customers/reliability-config';

export type ReliabilityTier = 'new' | 'reliable' | 'risk' | 'watch';

export type ReliabilityFlags = {
  cancelsOften: boolean;
  confirmsThenRefuses: boolean;
  hardToReach: boolean;
};

export type ReliabilityScoreInput = {
  attemptsWeighted: number;
  cancelledCount: number;
  confirmedWeighted: number;
  deliveredCount: number;
  deliveredWeighted: number;
  noResponseWeighted: number;
  orderCount: number;
  refusedCount: number;
  refusedWeighted: number;
};

export type ReliabilityScoreResult = {
  confirmScore: number | null;
  decided: number;
  deliveryScore: number;
  flags: ReliabilityFlags;
  isProvisional: boolean;
  score: number;
  tier: ReliabilityTier;
};

function recencyWeight(ageDays: number): number {
  return 0.5 ** (Math.max(ageDays, 0) / HALF_LIFE_DAYS);
}

export function weightByRecency(date: Date, referenceDate = new Date()): number {
  const ageMs = referenceDate.getTime() - date.getTime();
  return recencyWeight(ageMs / 86_400_000);
}

export function tierFromScore(score: number, decided: number): ReliabilityTier {
  if (decided < MIN_DECIDED) {
    return 'new';
  }

  if (score >= TIER_FIABLE) {
    return 'reliable';
  }

  if (score >= TIER_SURVEILLER) {
    return 'watch';
  }

  return 'risk';
}

export function computeReliabilityScore(input: ReliabilityScoreInput): ReliabilityScoreResult {
  const decided = input.deliveredCount + input.refusedCount;
  const deliveryScore =
    (input.deliveredWeighted + DELIVERY_PSEUDO_ORDERS * POPULATION_DELIVERY_SUCCESS) /
    (input.deliveredWeighted + input.refusedWeighted + DELIVERY_PSEUDO_ORDERS);
  const confirmScore =
    input.attemptsWeighted === 0
      ? null
      : (input.confirmedWeighted + CONFIRMATION_PSEUDO_CALLS * POPULATION_CONFIRMATION_SUCCESS) /
        (input.attemptsWeighted + CONFIRMATION_PSEUDO_CALLS);
  const score = Math.round(
    100 * (confirmScore === null ? deliveryScore : 0.7 * deliveryScore + 0.3 * confirmScore),
  );

  return {
    confirmScore,
    decided,
    deliveryScore,
    flags: {
      confirmsThenRefuses: (confirmScore ?? 0) >= 0.7 && deliveryScore < 0.5,
      hardToReach:
        input.attemptsWeighted > 0 &&
        input.noResponseWeighted / input.attemptsWeighted >= 0.5 &&
        input.deliveredCount > 0 &&
        deliveryScore >= 0.5,
      cancelsOften:
        input.cancelledCount >= 3 &&
        input.orderCount > 0 &&
        input.cancelledCount / input.orderCount > 0.4,
    },
    isProvisional: decided >= MIN_DECIDED && decided < PROVISIONAL_MAX,
    score,
    tier: tierFromScore(score, decided),
  };
}
