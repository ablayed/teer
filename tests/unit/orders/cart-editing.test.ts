import { calculateCartTotal, getOrderCartEditingMode } from '@/lib/orders/cart-editing';
import { shouldResyncShopifyOrderCart } from '@/lib/shopify/orders-sync';
import { describe, expect, it } from 'vitest';

describe('getOrderCartEditingMode', () => {
  it('garde l’édition complète avant assignation', () => {
    expect(getOrderCartEditingMode({ cashState: 'not_due', deliveryState: 'unassigned' })).toBe(
      'full',
    );
  });

  it('active la réduction seule après assignation tant que le cash n’est pas encaissé', () => {
    expect(getOrderCartEditingMode({ cashState: 'expected', deliveryState: 'assigned' })).toBe(
      'reduction',
    );
    expect(
      getOrderCartEditingMode({ cashState: 'expected', deliveryState: 'out_for_delivery' }),
    ).toBe('reduction');
  });

  it.each(['collected', 'remitted', 'discrepancy'] as const)(
    'refuse toute édition après encaissement (%s)',
    (cashState) => {
      expect(getOrderCartEditingMode({ cashState, deliveryState: 'out_for_delivery' })).toBeNull();
    },
  );

  it.each(['delivered', 'failed', 'returned'] as const)(
    'refuse les états de livraison terminaux (%s), même quand le cash n’est pas dû',
    (deliveryState) => {
      expect(getOrderCartEditingMode({ cashState: 'not_due', deliveryState })).toBeNull();
    },
  );

  it.each([
    { cashState: null, deliveryState: 'out_for_delivery' },
    { cashState: 'expected', deliveryState: null },
  ])('refuse les dimensions cash ou livraison nulles (%o)', ({ cashState, deliveryState }) => {
    expect(getOrderCartEditingMode({ cashState, deliveryState })).toBeNull();
  });

  it('garde la réduction seule pour une commande programmée dont le cash est attendu', () => {
    expect(getOrderCartEditingMode({ cashState: 'expected', deliveryState: 'scheduled' })).toBe(
      'reduction',
    );
  });
});

describe('réduction post-assignation et resynchronisation Shopify', () => {
  it('opèrent sur des états de livraison disjoints', () => {
    const assigned = {
      cart_locally_modified_at: null,
      cash_state: 'expected',
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
