import type { OrderListItem } from '@/lib/actions/orders';

export const orderSavedViewIds = [
  'toutes',
  'a-appeler',
  'tentee-a-rappeler',
  'confirmee',
  'en-livraison',
  'valide',
  'annulees-retours',
] as const;

export type OrderSavedViewId = (typeof orderSavedViewIds)[number];

export type OrderSavedViewDefinition = {
  id: OrderSavedViewId;
  label: string;
};

export type OrderSavedViewCount = OrderSavedViewDefinition & {
  count: number;
};

export const orderSavedViews: OrderSavedViewDefinition[] = [
  { id: 'toutes', label: 'Toutes' },
  { id: 'a-appeler', label: 'À appeler' },
  { id: 'tentee-a-rappeler', label: 'Tentée / À rappeler' },
  // L'id `confirmee` est CONSERVE (deep-links existants) ; seul le label change.
  { id: 'confirmee', label: 'Programmer' },
  { id: 'en-livraison', label: 'En cours de livraison' },
  { id: 'valide', label: 'Validé' },
  { id: 'annulees-retours', label: 'Annulées / Retours' },
] as const;

type OrderListViewShape = Pick<
  OrderListItem,
  | 'call_state'
  | 'created_at'
  | 'created_at_shopify'
  | 'delivery_state'
  | 'next_contact_at'
  | 'order_state'
>;

export function startOfLocalDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function isSameLocalDate(value: string | null, date = new Date()) {
  if (!value) {
    return false;
  }

  const target = startOfLocalDay(date);
  const candidate = startOfLocalDay(new Date(value));
  return candidate.getTime() === target.getTime();
}

export function orderQueueDate(
  order: Pick<OrderListViewShape, 'created_at' | 'created_at_shopify'>,
) {
  return order.created_at_shopify ?? order.created_at;
}

export function parseOrderSavedViewId(value: string | undefined): OrderSavedViewId {
  return orderSavedViewIds.includes(value as OrderSavedViewId)
    ? (value as OrderSavedViewId)
    : 'toutes';
}

export function matchesOrderSavedView(order: OrderListViewShape, viewId: OrderSavedViewId) {
  switch (viewId) {
    case 'toutes':
      return true;
    case 'a-appeler':
      return order.order_state === 'open' && order.call_state === 'to_call';
    case 'tentee-a-rappeler':
      return order.order_state === 'open' && order.call_state === 'callback';
    case 'confirmee':
      // Phase 11.1 : la vue « Programmer » garde aussi les commandes « assignées »
      // (livreur choisi, popup détails/prix non encore confirmé) — elles n'entrent
      // dans « En cours de livraison » qu'après confirmation. Aligné migration 0062.
      return (
        order.order_state === 'open' &&
        order.call_state === 'validated' &&
        (order.delivery_state === 'unassigned' ||
          order.delivery_state === 'scheduled' ||
          order.delivery_state === 'assigned')
      );
    case 'en-livraison':
      // En cours de livraison = uniquement out_for_delivery (après confirmation du
      // popup d'assignation). Aligné sur la migration 0062.
      return order.delivery_state === 'out_for_delivery';
    case 'valide':
      return order.order_state === 'completed';
    case 'annulees-retours':
      // Regroupement d'AFFICHAGE uniquement : `cancelled` et `returned` restent
      // deux order_state distincts en base (les analytics de pertes en dependent).
      return order.order_state === 'cancelled' || order.order_state === 'returned';
  }
}

export function applyOrderSavedViewCountTransition<T extends OrderSavedViewCount>(
  views: T[],
  previousOrder: OrderListViewShape,
  nextOrder: OrderListViewShape,
): T[] {
  return views.map((view) => {
    const previousMatched = matchesOrderSavedView(previousOrder, view.id);
    const nextMatched = matchesOrderSavedView(nextOrder, view.id);
    const delta = Number(nextMatched) - Number(previousMatched);

    return delta === 0 ? view : { ...view, count: Math.max(0, view.count + delta) };
  });
}

export function compareOrdersForSavedView(
  left: OrderListViewShape,
  right: OrderListViewShape,
  viewId: OrderSavedViewId,
) {
  if (viewId === 'tentee-a-rappeler') {
    const leftDate = left.next_contact_at ?? orderQueueDate(left);
    const rightDate = right.next_contact_at ?? orderQueueDate(right);
    return leftDate.localeCompare(rightDate);
  }

  return orderQueueDate(right).localeCompare(orderQueueDate(left));
}

export function buildOrderViewHref(
  viewId: OrderSavedViewId,
  options: { period?: string; shopId?: string | null } = {},
) {
  if (viewId === 'toutes' && !options.period && !options.shopId) {
    return '/commandes';
  }

  const params = new URLSearchParams();
  if (viewId !== 'toutes') {
    params.set('vue', viewId);
  }
  if (options.period) {
    params.set('period', options.period);
  }
  if (options.shopId) {
    params.set('shop', options.shopId);
  }

  const query = params.toString();
  return query ? `/commandes?${query}` : '/commandes';
}
