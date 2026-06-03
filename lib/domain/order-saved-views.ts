import type { OrderListItem } from '@/lib/actions/orders';

export const orderSavedViewIds = [
  'toutes',
  'a-appeler',
  'tentee-a-rappeler',
  'confirmee',
  'a-livrer-aujourdhui',
  'cash-a-remettre',
  'annulees',
  'retours',
] as const;

export type OrderSavedViewId = (typeof orderSavedViewIds)[number];

export type OrderSavedViewDefinition = {
  id: OrderSavedViewId;
  label: string;
};

export const orderSavedViews: OrderSavedViewDefinition[] = [
  { id: 'toutes', label: 'Toutes' },
  { id: 'a-appeler', label: '\u00c0 appeler' },
  { id: 'tentee-a-rappeler', label: 'Tent\u00e9e / \u00c0 rappeler' },
  { id: 'confirmee', label: 'Confirm\u00e9e' },
  { id: 'a-livrer-aujourdhui', label: "\u00c0 livrer aujourd'hui" },
  { id: 'cash-a-remettre', label: 'Cash \u00e0 remettre' },
  { id: 'annulees', label: 'Annul\u00e9es' },
  { id: 'retours', label: 'Retours' },
] as const;

type OrderListViewShape = Pick<
  OrderListItem,
  | 'call_state'
  | 'cash_state'
  | 'created_at'
  | 'created_at_shopify'
  | 'delivery_state'
  | 'next_contact_at'
  | 'order_state'
  | 'scheduled_for'
>;

function startOfLocalDay(date = new Date()) {
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

function queueDate(order: OrderListViewShape) {
  return order.created_at_shopify ?? order.created_at;
}

export function parseOrderSavedViewId(value: string | undefined): OrderSavedViewId {
  return orderSavedViewIds.includes(value as OrderSavedViewId)
    ? (value as OrderSavedViewId)
    : 'toutes';
}

export function matchesOrderSavedView(
  order: OrderListViewShape,
  viewId: OrderSavedViewId,
  today = new Date(),
) {
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
        (order.delivery_state === 'unassigned' || order.delivery_state === 'scheduled')
      );
    case 'a-livrer-aujourdhui':
      return (
        (order.delivery_state === 'scheduled' ||
          order.delivery_state === 'assigned' ||
          order.delivery_state === 'out_for_delivery') &&
        isSameLocalDate(order.scheduled_for, today)
      );
    case 'cash-a-remettre':
      return order.cash_state === 'collected';
    case 'annulees':
      return order.order_state === 'cancelled';
    case 'retours':
      return order.order_state === 'returned';
  }
}

export function compareOrdersForSavedView(
  left: OrderListViewShape,
  right: OrderListViewShape,
  viewId: OrderSavedViewId,
) {
  if (viewId === 'tentee-a-rappeler') {
    const leftDate = left.next_contact_at ?? queueDate(left);
    const rightDate = right.next_contact_at ?? queueDate(right);
    return leftDate.localeCompare(rightDate);
  }

  return queueDate(right).localeCompare(queueDate(left));
}

export function buildOrderViewHref(viewId: OrderSavedViewId) {
  return viewId === 'toutes' ? '/commandes' : `/commandes?vue=${viewId}`;
}
