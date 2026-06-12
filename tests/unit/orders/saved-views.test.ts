import {
  type OrderSavedViewId,
  compareOrdersForSavedView,
  matchesOrderSavedView,
} from '@/lib/domain/order-saved-views';
import { filterOrdersBySearch, orderItemsSearchText } from '@/lib/orders/search';
import { describe, expect, it } from 'vitest';

type OrderFixture = {
  call_state: 'callback' | 'to_call' | 'validated';
  cash_state: 'collected' | 'expected' | 'not_due';
  created_at: string;
  created_at_shopify: string | null;
  customer: {
    full_name: string | null;
    phone: string | null;
  } | null;
  delivery_state:
    | 'assigned'
    | 'delivered'
    | 'failed'
    | 'out_for_delivery'
    | 'scheduled'
    | 'unassigned';
  items_summary: Array<{ title: string }> | null;
  next_contact_at: string | null;
  order_state: 'cancelled' | 'completed' | 'open' | 'returned';
  scheduled_for: string | null;
};

function orderFixture(overrides: Partial<OrderFixture> = {}): OrderFixture {
  return {
    call_state: 'to_call',
    cash_state: 'not_due',
    created_at: '2026-06-03T08:00:00.000Z',
    created_at_shopify: '2026-06-03T08:00:00.000Z',
    customer: {
      full_name: 'Awa Diop',
      phone: '+221771234567',
    },
    delivery_state: 'unassigned',
    items_summary: [{ title: 'Sac cuir' }],
    next_contact_at: null,
    order_state: 'open',
    scheduled_for: null,
    ...overrides,
  };
}

describe('order saved views', () => {
  const cases: Array<{
    order: OrderFixture;
    view: OrderSavedViewId;
  }> = [
    {
      order: orderFixture(),
      view: 'a-appeler',
    },
    {
      order: orderFixture({
        call_state: 'callback',
        next_contact_at: '2026-06-03T12:00:00.000Z',
      }),
      view: 'tentee-a-rappeler',
    },
    {
      order: orderFixture({
        call_state: 'validated',
      }),
      view: 'confirmee',
    },
    {
      // En cours de livraison : delivery ∈ {scheduled, assigned, out_for_delivery}, sans date.
      order: orderFixture({
        call_state: 'validated',
        cash_state: 'expected',
        delivery_state: 'assigned',
      }),
      view: 'en-livraison',
    },
    {
      // Validé : order_state = completed.
      order: orderFixture({
        call_state: 'validated',
        cash_state: 'collected',
        delivery_state: 'delivered',
        order_state: 'completed',
      }),
      view: 'valide',
    },
    {
      // Annulées / Retours regroupe cancelled…
      order: orderFixture({
        call_state: 'validated',
        order_state: 'cancelled',
      }),
      view: 'annulees-retours',
    },
    {
      // …et returned dans une seule vue d'affichage.
      order: orderFixture({
        delivery_state: 'failed',
        order_state: 'returned',
      }),
      view: 'annulees-retours',
    },
  ];

  it('applique les vues sauvegardees attendues', () => {
    for (const testCase of cases) {
      expect(matchesOrderSavedView(testCase.order, 'toutes')).toBe(true);
      expect(matchesOrderSavedView(testCase.order, testCase.view)).toBe(true);
    }
  });

  it('trie les rappels par next_contact_at croissant', () => {
    const early = orderFixture({
      call_state: 'callback',
      next_contact_at: '2026-06-03T09:00:00.000Z',
    });
    const late = orderFixture({
      call_state: 'callback',
      next_contact_at: '2026-06-03T14:00:00.000Z',
    });

    expect(compareOrdersForSavedView(early, late, 'tentee-a-rappeler')).toBeLessThan(0);
  });
});

describe('order search helpers', () => {
  it('extrait le texte produit de items_summary', () => {
    expect(orderItemsSearchText([{ title: 'Sac cuir' }, { title: 'Ceinture' }])).toBe(
      'sac cuir ceinture',
    );
  });

  it('filtre les commandes par nom, telephone et produit', () => {
    const orders = [
      orderFixture({
        customer: {
          full_name: 'Awa Diop',
          phone: '+221771234567',
        },
        items_summary: [{ title: 'Sac cuir noir' }],
      }),
      orderFixture({
        customer: {
          full_name: 'Moussa Ndiaye',
          phone: '+221781112233',
        },
        items_summary: [{ title: 'Montre argent' }],
      }),
    ];

    expect(filterOrdersBySearch(orders, 'awa')).toHaveLength(1);
    expect(filterOrdersBySearch(orders, '771234567')).toHaveLength(1);
    expect(filterOrdersBySearch(orders, 'montre')).toHaveLength(1);
    expect(filterOrdersBySearch(orders, 'introuvable')).toHaveLength(0);
  });
});
