import { z } from 'zod';

export const ORDER_TOTAL_POSITIVE_MESSAGE = 'Le total doit être supérieur à 0 F CFA.';

export const positiveOrderTotalSchema = z.number().int().positive(ORDER_TOTAL_POSITIVE_MESSAGE);

export function parsePositiveOrderTotalInput(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
