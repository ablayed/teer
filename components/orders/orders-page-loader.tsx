'use client';

import { CodStatusBadge } from '@/components/orders/cod-status-badge';
import { CustomerReliabilityBadge } from '@/components/orders/customer-reliability-badge';
import { OrderInlineActions } from '@/components/orders/order-inline-actions';
import type { DriverOption } from '@/components/orders/transition-dialog';
import {
  type OrderListCursor,
  type OrderListItem,
  loadMoreOrdersAction,
} from '@/lib/actions/orders';
import type { OrderSavedViewId } from '@/lib/domain/order-saved-views';
import { orderStatusLabels } from '@/lib/domain/order-state-machine';
import { formatDateRelative } from '@/lib/format/date';
import { formatMoney } from '@/lib/format/fcfa';
import type { Json } from '@/lib/supabase/database.types';
import { buildWhatsAppConfirmationUrl, firstName } from '@/lib/whatsapp/link';
import Link from 'next/link';
import { useEffect, useState, useTransition } from 'react';

type ReliabilityTier = 'new' | 'reliable' | 'risk' | 'watch';

type Props = {
  activeView: OrderSavedViewId;
  drivers: DriverOption[];
  emptyValueLabel: string;
  initialHasMore: boolean;
  initialNextCursor: OrderListCursor | null;
  initialOrders: OrderListItem[];
  initialReliabilityTiers: Record<string, ReliabilityTier>;
  merchantName: string;
  reliabilityLabels: Record<ReliabilityTier, string>;
  searchQuery: string;
  whatsappMissingPhoneLabel: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function formatOrderAddress(value: Json | null): string | null {
  if (!isRecord(value)) {
    return null;
  }

  const parts = [
    stringField(value, 'address1'),
    stringField(value, 'address2'),
    stringField(value, 'city'),
    stringField(value, 'province'),
    stringField(value, 'country'),
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(', ') : null;
}

export function OrdersPageLoader({
  activeView,
  drivers,
  emptyValueLabel,
  initialHasMore,
  initialNextCursor,
  initialOrders,
  initialReliabilityTiers,
  merchantName,
  reliabilityLabels,
  searchQuery,
  whatsappMissingPhoneLabel,
}: Props) {
  const [orders, setOrders] = useState(initialOrders);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [reliabilityTiers, setReliabilityTiers] = useState(initialReliabilityTiers);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    setOrders(initialOrders);
    setHasMore(initialHasMore);
    setNextCursor(initialNextCursor);
    setReliabilityTiers(initialReliabilityTiers);
  }, [initialHasMore, initialNextCursor, initialOrders, initialReliabilityTiers]);

  function handleLoadMore() {
    if (!nextCursor) {
      return;
    }

    startTransition(async () => {
      const result = await loadMoreOrdersAction({
        cursor: nextCursor,
        search: searchQuery,
        view: activeView,
      });
      const data = result?.data;

      if (!data?.ok) {
        return;
      }

      setOrders((previous) => [...previous, ...data.orders]);
      setHasMore(data.hasMore);
      setNextCursor(data.nextCursor);
      setReliabilityTiers((previous) => ({
        ...previous,
        ...data.reliabilityTiers,
      }));
    });
  }

  return (
    <section className="space-y-3">
      {orders.map((order) => (
        <article
          className="rounded-lg border border-border bg-surface p-4 shadow-1 transition-colors hover:bg-canvas/50"
          key={order.id}
        >
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <Link className="min-w-0 flex-1 space-y-3" href={`/commandes/${order.id}`}>
              <div className="flex flex-wrap items-center gap-3">
                <p className="font-mono text-sm font-semibold text-muted">
                  {order.order_number ?? emptyValueLabel}
                </p>
                <CodStatusBadge status={order.cod_status as keyof typeof orderStatusLabels} />
                <span className="text-sm text-muted">
                  {orderStatusLabels[order.cod_status as keyof typeof orderStatusLabels]}
                </span>
              </div>

              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-base font-semibold">
                    {order.customer?.full_name ?? emptyValueLabel}
                  </p>
                  <CustomerReliabilityBadge
                    labels={reliabilityLabels}
                    tier={order.customer_id ? (reliabilityTiers[order.customer_id] ?? null) : null}
                  />
                </div>
                <p className="text-sm text-muted">
                  {formatDateRelative(order.created_at_shopify ?? order.created_at)}
                </p>
              </div>
            </Link>

            <div className="flex flex-col items-start gap-3 md:items-end">
              <p className="text-lg font-semibold">
                {formatMoney(order.total_amount, order.currency)}
              </p>
              <OrderInlineActions
                allowedActions={order.allowedActions}
                drivers={drivers}
                orderId={order.id}
                phone={order.customer?.phone ?? null}
                whatsappMissingPhoneLabel={whatsappMissingPhoneLabel}
                whatsappUrl={buildWhatsAppConfirmationUrl({
                  address: formatOrderAddress(order.shipping_address),
                  currency: order.currency,
                  customerFirstName: firstName(order.customer?.full_name),
                  itemsSummary: order.items_summary,
                  orderNumber: order.order_number,
                  phone: order.customer?.phone ?? null,
                  shopName: merchantName,
                  totalAmount: order.total_amount,
                })}
              />
            </div>
          </div>
        </article>
      ))}

      {hasMore && nextCursor ? (
        <div className="flex justify-center pt-2">
          <button
            className="rounded-lg border border-border bg-surface px-6 py-3 text-sm font-medium text-text hover:bg-canvas disabled:opacity-60"
            disabled={isPending}
            onClick={handleLoadMore}
            type="button"
          >
            {isPending ? 'Chargement...' : 'Voir plus'}
          </button>
        </div>
      ) : null}
    </section>
  );
}
