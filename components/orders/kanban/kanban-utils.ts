import type { OrderListItem } from '@/lib/actions/orders';
import type { OrderStatus } from '@/lib/domain/order-state-machine';
import { type CodStatus, isCodStatus } from '@/lib/orders/status';

export type KanbanColumnKey =
  | 'A_APPELER'
  | 'TENTEE'
  | 'CONFIRMEE'
  | 'EN_LIVRAISON'
  | 'LIVREE'
  | 'ANNULEE_REFUSEE';

export function normalizeOrderStatus(status: string): OrderStatus {
  return isCodStatus(status) ? status : 'A_APPELER';
}

export function getKanbanColumnKey(status: string): KanbanColumnKey {
  const normalizedStatus = normalizeOrderStatus(status);

  switch (normalizedStatus) {
    case 'A_APPELER':
      return 'A_APPELER';
    case 'TENTEE':
      return 'TENTEE';
    case 'CONFIRMEE':
      return 'CONFIRMEE';
    case 'PROGRAMMEE':
    case 'EN_LIVRAISON':
      return 'EN_LIVRAISON';
    case 'LIVREE':
      return 'LIVREE';
    case 'REFUSEE':
    case 'ANNULEE':
      return 'ANNULEE_REFUSEE';
  }
}

export function getKanbanDropTarget(columnKey: KanbanColumnKey): OrderStatus {
  switch (columnKey) {
    case 'A_APPELER':
      return 'A_APPELER';
    case 'TENTEE':
      return 'TENTEE';
    case 'CONFIRMEE':
      return 'CONFIRMEE';
    case 'EN_LIVRAISON':
      return 'PROGRAMMEE';
    case 'LIVREE':
      return 'LIVREE';
    case 'ANNULEE_REFUSEE':
      return 'ANNULEE';
  }
}

export function groupOrdersByKanbanColumn(orders: OrderListItem[]) {
  return orders.reduce<Record<KanbanColumnKey, OrderListItem[]>>(
    (columns, order) => {
      columns[getKanbanColumnKey(order.cod_status)].push(order);
      return columns;
    },
    {
      A_APPELER: [],
      TENTEE: [],
      CONFIRMEE: [],
      EN_LIVRAISON: [],
      LIVREE: [],
      ANNULEE_REFUSEE: [],
    },
  );
}
