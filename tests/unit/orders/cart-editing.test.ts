import { calculateCartTotal, getOrderCartEditingMode } from '@/lib/orders/cart-editing';
import { shouldResyncShopifyOrderCart } from '@/lib/shopify/orders-sync';
import { describe, expect, it } from 'vitest';

describe('getOrderCartEditingMode', () => {
  it('garde l’édition complète avant assignation', () => {
    expect(getOrderCartEditingMode({ cashState: 'not_due', deliveryState: 'unassigned' })).toBe(
      'full',
    );
  });

  it('active la réduction seule après assignation tant que le cash n’est pas dû', () => {
    expect(getOrderCartEditingMode({ cashState: 'not_due', deliveryState: 'assigned' })).toBe(
      'reduction',
    );
    expect(
      getOrderCartEditingMode({ cashState: 'not_due', deliveryState: 'out_for_delivery' }),
    ).toBe('reduction');
  });

  it('refuse toute édition après encaissement', () => {
    expect(
      getOrderCartEditingMode({ cashState: 'expected', deliveryState: 'assigned' }),
    ).toBeNull();
  });
});

describe('réduction post-assignation et resynchronisation Shopify', () => {
  it('opèrent sur des états de livraison disjoints', () => {
    const assigned = {
      cart_locally_modified_at: null,
      cash_state: 'not_due',
      delivery_state: 'assigned',
    } as const;

    expect(
      getOrderCartEditingMode({
        cashState: assigned.cash_state,
        deliveryState: assigned.delivery_state,
      }),
    ).toBe('reduction');
    expect(shouldResyncShopifyOrderCart(assigned)).toBe(false);
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
