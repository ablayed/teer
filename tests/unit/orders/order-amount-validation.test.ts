import {
  ORDER_TOTAL_POSITIVE_MESSAGE,
  parsePositiveOrderTotalInput,
  positiveOrderTotalSchema,
} from '@/lib/orders/order-amount-validation';
import { describe, expect, it } from 'vitest';

describe('validation du total de commande', () => {
  it.each(['', '   ', '0', '-1', 'abc'])("rejette la saisie '%s'", (value) => {
    expect(parsePositiveOrderTotalInput(value)).toBeNull();
  });

  it('conserve une saisie strictement positive pour son arrondi au submit', () => {
    expect(parsePositiveOrderTotalInput('11900')).toBe(11_900);
    expect(parsePositiveOrderTotalInput('11900.4')).toBe(11_900.4);
  });

  it('rejette aussi zéro côté serveur avec un message explicite', () => {
    const result = positiveOrderTotalSchema.safeParse(0);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(ORDER_TOTAL_POSITIVE_MESSAGE);
    }
  });
});
