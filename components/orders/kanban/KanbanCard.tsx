'use client';

import { CodStatusBadge } from '@/components/orders/cod-status-badge';
import type { OrderListItem } from '@/lib/actions/orders';
import type { OrderStatus } from '@/lib/domain/order-state-machine';
import { formatDateRelative } from '@/lib/format/date';
import { formatMoney } from '@/lib/format/fcfa';
import Link from 'next/link';

type KanbanCardProps = {
  emptyLabel: string;
  order: OrderListItem;
};

function orderStatus(orderStatus: string): OrderStatus {
  if (
    orderStatus === 'TENTEE' ||
    orderStatus === 'CONFIRMEE' ||
    orderStatus === 'PROGRAMMEE' ||
    orderStatus === 'EN_LIVRAISON' ||
    orderStatus === 'LIVREE' ||
    orderStatus === 'REFUSEE' ||
    orderStatus === 'ANNULEE'
  ) {
    return orderStatus;
  }

  return 'A_APPELER';
}

export function KanbanCard({ emptyLabel, order }: KanbanCardProps) {
  const orderLabel = order.order_number ?? emptyLabel;
  const customerLabel = order.customer?.full_name ?? emptyLabel;
  const orderDate = order.created_at_shopify ?? order.created_at;

  return (
    <Link
      className="flex min-h-24 flex-col gap-3 rounded-md border border-border bg-surface p-3 text-left shadow-1 transition duration-120 hover:-translate-y-0.5 hover:shadow-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      href={`/commandes/${order.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="font-mono text-sm font-semibold tabular-nums text-text">{orderLabel}</p>
        <CodStatusBadge status={orderStatus(order.cod_status)} />
      </div>
      <p className="min-w-0 truncate text-sm text-text">{customerLabel}</p>
      <div className="mt-auto flex items-end justify-between gap-3">
        <p className="font-mono text-sm font-medium tabular-nums text-text">
          {formatMoney(order.total_amount, order.currency)}
        </p>
        <p className="text-xs text-muted">{formatDateRelative(orderDate)}</p>
      </div>
    </Link>
  );
}
