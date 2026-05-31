export function calculateRatePct(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }

  return Number(((numerator / denominator) * 100).toFixed(2));
}

export function calculateTauxConfirmation(confirmedCount: number, createdCount: number): number {
  return calculateRatePct(confirmedCount, createdCount);
}

export function calculateTauxLivraison({
  deliveredCount,
  postConfirmationFailedCount,
}: {
  deliveredCount: number;
  postConfirmationFailedCount: number;
}): number {
  return calculateRatePct(deliveredCount, deliveredCount + postConfirmationFailedCount);
}
