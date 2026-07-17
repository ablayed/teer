import { calculateCartTotal, canEditOrderCart } from '@/lib/orders/cart-editing';
import { describe, expect, it } from 'vitest';

describe('canEditOrderCart', () => {
  it('autorise uniquement une commande non assignée et non due', () => {
    expect(canEditOrderCart({ deliveryState: 'unassigned', cashState: 'not_due' })).toBe(true);
  });

  it('refuse une commande assignée ou encaissable', () => {
    expect(canEditOrderCart({ deliveryState: 'assigned', cashState: 'not_due' })).toBe(false);
    expect(canEditOrderCart({ deliveryState: 'unassigned', cashState: 'expected' })).toBe(false);
  });
});

describe('calculateCartTotal', () => {
  it('recalcule le total à partir des prix manuels et quantités', () => {
    expect(
      calculateCartTotal([
        { quantity: 2, unitPrice: 1500 },
        { quantity: 3, unitPrice: 250 },
      ]),
    ).toBe(3750);
  });
});
