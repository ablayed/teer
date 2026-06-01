import type { OrderListItem } from '@/lib/actions/orders';
import { type CodStatus, isCodStatus } from '@/lib/orders/status';

export type KanbanColumnKey =
  | 'A_APPELER'
  | 'TENTEE'
  | 'CONFIRMEE'
  | 'EN_LIVRAISON'
  | 'LIVREE'
  | 'ANNULEE_REFUSEE';

function normalizeStatus(status: string): CodStatus {
  return isCodStatus(status) ? status : 'A_APPELER';
}

export function getKanbanColumnKey(status: string): KanbanColumnKey {
  const normalizedStatus = normalizeStatus(status);

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
