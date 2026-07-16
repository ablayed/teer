import {
  type OrderSavedViewId,
  applyOrderSavedViewCountTransition,
  compareOrdersForSavedView,
  mapOrderViewCountRows,
  matchesOrderSavedView,
  orderSavedViews,
} from '@/lib/domain/order-saved-views';
import {
  filterOrdersBySearch,
  normalizeOrderNumberSearch,
  orderItemsSearchText,
} from '@/lib/orders/search';
import { describe, expect, it } from 'vitest';

type OrderFixture = {
  call_state: 'callback' | 'to_call' | 'unreachable' | 'validated';
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
    | 'returned'
    | 'scheduled'
    | 'unassigned';
  items_summary: Array<{ title: string }> | null;
  next_contact_at: string | null;
  order_number: string | null;
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
    order_number: '#2921',
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
      // En cours de livraison : delivery = out_for_delivery uniquement (0062).
      order: orderFixture({
        call_state: 'validated',
        cash_state: 'expected',
        delivery_state: 'out_for_delivery',
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

  it('reste aligne avec les predicats SQL des RPC saved-views (0052, en-livraison/confirmee maj 0062)', () => {
    const orderStates = ['cancelled', 'completed', 'open', 'returned'] as const;
    const callStates = ['callback', 'to_call', 'unreachable', 'validated'] as const;
    const deliveryStates = [
      'assigned',
      'delivered',
      'failed',
      'out_for_delivery',
      'returned',
      'scheduled',
      'unassigned',
    ] as const;

    function rpcPredicate(order: OrderFixture, viewId: OrderSavedViewId) {
      switch (viewId) {
        case 'toutes':
          return true;
        case 'a-appeler':
          return order.order_state === 'open' && order.call_state === 'to_call';
        case 'tentee-a-rappeler':
          return order.order_state === 'open' && order.call_state === 'callback';
        case 'confirmee':
          return (
            order.order_state === 'open' &&
            order.call_state === 'validated' &&
            (order.delivery_state === 'unassigned' ||
              order.delivery_state === 'scheduled' ||
              order.delivery_state === 'assigned')
          );
        case 'en-livraison':
          return order.delivery_state === 'out_for_delivery';
        case 'valide':
          return order.order_state === 'completed';
        case 'annulees-retours':
          return order.order_state === 'cancelled' || order.order_state === 'returned';
      }
    }

    for (const order_state of orderStates) {
      for (const call_state of callStates) {
        for (const delivery_state of deliveryStates) {
          const order = orderFixture({ call_state, delivery_state, order_state });

          for (const view of orderSavedViews) {
            expect(matchesOrderSavedView(order, view.id), view.id).toBe(
              rpcPredicate(order, view.id),
            );
          }
        }
      }
    }
  });

  it('met a jour les compteurs quand une commande change de vue localement', () => {
    const previousOrder = orderFixture({
      call_state: 'to_call',
      delivery_state: 'unassigned',
      order_state: 'open',
    });
    const nextOrder = orderFixture({
      call_state: 'validated',
      delivery_state: 'unassigned',
      order_state: 'open',
    });
    const views = orderSavedViews.map((view) => ({
      ...view,
      count: view.id === 'a-appeler' || view.id === 'toutes' ? 1 : 0,
    }));

    const nextViews = applyOrderSavedViewCountTransition(views, previousOrder, nextOrder);

    expect(nextViews.find((view) => view.id === 'toutes')?.count).toBe(1);
    expect(nextViews.find((view) => view.id === 'a-appeler')?.count).toBe(0);
    expect(nextViews.find((view) => view.id === 'confirmee')?.count).toBe(1);
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

  it.each(['2921', '#2921', '# 2921', '#  2921  '])(
    'normalise le numero Shopify %s et retrouve la commande',
    (search) => {
      const shopifyOrder = orderFixture({ order_number: '#2921' });

      expect(normalizeOrderNumberSearch(search)).toBe('2921');
      expect(filterOrdersBySearch([shopifyOrder], search)).toEqual([shopifyOrder]);
    },
  );

  it('ne confond pas un numero manuel M-2921 et un numero Shopify #2921', () => {
    const shopifyOrder = orderFixture({ order_number: '#2921' });
    const manualOrder = orderFixture({ order_number: 'M-2921' });

    expect(filterOrdersBySearch([shopifyOrder, manualOrder], '2921')).toEqual([shopifyOrder]);
    expect(filterOrdersBySearch([shopifyOrder, manualOrder], 'm-2921')).toEqual([manualOrder]);
  });
});

// Lot 6 (migration 0088, get_order_view_counts) — mapping pur RPC → shape des compteurs.
describe('mapOrderViewCountRows', () => {
  it('mappe les 7 vues connues sur la shape attendue', () => {
    const counts = mapOrderViewCountRows([
      { count: 12, view_id: 'toutes' },
      { count: 3, view_id: 'a-appeler' },
      { count: 1, view_id: 'tentee-a-rappeler' },
      { count: 2, view_id: 'confirmee' },
      { count: 4, view_id: 'en-livraison' },
      { count: 1, view_id: 'valide' },
      { count: 1, view_id: 'annulees-retours' },
    ]);

    expect(counts).toEqual({
      toutes: 12,
      'a-appeler': 3,
      'tentee-a-rappeler': 1,
      confirmee: 2,
      'en-livraison': 4,
      valide: 1,
      'annulees-retours': 1,
    });
  });

  it('vue manquante dans la réponse RPC → reste à 0 (pas d’exception)', () => {
    const counts = mapOrderViewCountRows([{ count: 5, view_id: 'toutes' }]);

    expect(counts.toutes).toBe(5);
    expect(counts['a-appeler']).toBe(0);
    expect(counts['en-livraison']).toBe(0);
  });

  it('view_id inconnu (RPC future/valeur inattendue) → ignoré silencieusement', () => {
    const counts = mapOrderViewCountRows([
      { count: 5, view_id: 'toutes' },
      { count: 99, view_id: 'vue-future-inconnue' },
    ]);

    expect(counts.toutes).toBe(5);
    expect(Object.values(counts).reduce((sum, value) => sum + value, 0)).toBe(5);
  });

  it('tableau vide → toutes les vues à 0', () => {
    const counts = mapOrderViewCountRows([]);

    expect(Object.values(counts).every((value) => value === 0)).toBe(true);
  });
});
