'use client';

import { CodStatusBadge } from '@/components/orders/cod-status-badge';
import { normalizeOrderStatus } from '@/components/orders/kanban/kanban-utils';
import type { OrderListItem } from '@/lib/actions/orders';
import { formatDateRelative } from '@/lib/format/date';
import { formatMoney } from '@/lib/format/fcfa';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import type { ReactNode } from 'react';

type KanbanCardProps = {
  actions?: ReactNode;
  emptyLabel: string;
  isOverlay?: boolean;
  order: OrderListItem;
};

export function KanbanCard({ actions, emptyLabel, isOverlay = false, order }: KanbanCardProps) {
  const orderLabel = order.order_number ?? emptyLabel;
  const customerLabel = order.customer?.full_name ?? emptyLabel;
  const orderDate = order.created_at_shopify ?? order.created_at;

  return (
    <div
      className={cn(
        'flex min-h-24 flex-col gap-3 rounded-md border border-border bg-surface p-3 text-left shadow-1 transition duration-120 focus-within:ring-2 focus-within:ring-accent/60 md:hover:shadow-2',
        isOverlay && 'scale-[1.04] shadow-2',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <Link
          className="min-h-11 min-w-0 flex-1 font-mono text-sm font-semibold tabular-nums text-text focus-visible:outline-none"
          href={`/commandes/${order.id}`}
        >
          {orderLabel}
        </Link>
        <div className="flex shrink-0 items-start gap-2">
          <CodStatusBadge
            deliveryState={order.delivery_state}
            status={normalizeOrderStatus(order.cod_status)}
          />
          {actions}
        </div>
      </div>
      <Link
        className="min-h-11 min-w-0 text-sm text-text focus-visible:outline-none"
        href={`/commandes/${order.id}`}
      >
        <span className="block truncate">{customerLabel}</span>
      </Link>
      <Link
        className="mt-auto flex min-h-11 items-end justify-between gap-3 focus-visible:outline-none"
        href={`/commandes/${order.id}`}
      >
        <span className="font-mono text-sm font-medium tabular-nums text-text">
          {formatMoney(order.total_amount, order.currency)}
        </span>
        <span className="text-xs text-muted">{formatDateRelative(orderDate)}</span>
      </Link>
    </div>
  );
}
