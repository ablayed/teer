'use client';

import { CodStatusBadge } from '@/components/orders/cod-status-badge';
import { CustomerReliabilityBadge } from '@/components/orders/customer-reliability-badge';
import { OrderActionsMenu } from '@/components/orders/order-actions-menu';
import { OrderDriverReassign } from '@/components/orders/order-driver-reassign';
import type { DriverOption } from '@/components/orders/transition-dialog';
import {
  type OrderListCursor,
  type OrderListItem,
  loadMoreOrdersAction,
} from '@/lib/actions/orders';
import type { TransitionResult } from '@/lib/actions/transitions';
import { matchesOrderSavedView } from '@/lib/domain/order-saved-views';
import type { OrderSavedViewId } from '@/lib/domain/order-saved-views';
import { orderStatusLabels } from '@/lib/domain/order-state-machine';
import { formatDateRelative } from '@/lib/format/date';
import { formatMoney } from '@/lib/format/fcfa';
import type { Json } from '@/lib/supabase/database.types';
import { cn } from '@/lib/utils';
import {
  buildWhatsAppConfirmationUrl,
  buildWhatsAppDispatchUrl,
  firstName,
} from '@/lib/whatsapp/link';
import Link from 'next/link';
import { useEffect, useState, useTransition } from 'react';

type ReliabilityTier = 'new' | 'reliable' | 'risk' | 'watch';
type TransitionSuccess = Extract<TransitionResult, { ok: true }>;

type Props = {
  activeView: OrderSavedViewId;
  canReassign: boolean;
  drivers: DriverOption[];
  emptyValueLabel: string;
  initialHasMore: boolean;
  initialNextCursor: OrderListCursor | null;
  initialOrders: OrderListItem[];
  initialReliabilityTiers: Record<string, ReliabilityTier>;
  isTransitionPending: boolean;
  merchantName: string;
  reliabilityLabels: Record<ReliabilityTier, string>;
  searchQuery: string;
  onTransitionApplied?: (event: {
    nextOrder: OrderListItem;
    previousOrder: OrderListItem;
  }) => void;
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
  canReassign,
  drivers,
  emptyValueLabel,
  initialHasMore,
  initialNextCursor,
  initialOrders,
  initialReliabilityTiers,
  isTransitionPending,
  merchantName,
  reliabilityLabels,
  searchQuery,
  onTransitionApplied,
  whatsappMissingPhoneLabel,
}: Props) {
  const [orders, setOrders] = useState(initialOrders);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [reliabilityTiers, setReliabilityTiers] = useState(initialReliabilityTiers);
  const [isLoadingMore, startTransition] = useTransition();

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

  function handleTransitionSuccess(result: TransitionSuccess) {
    const previousOrder = orders.find((order) => order.id === result.order.id);

    if (!previousOrder) {
      return;
    }

    const nextOrder: OrderListItem = {
      ...previousOrder,
      assigned_driver_id: result.order.assigned_driver_id,
      call_state: result.order.call_state,
      cash_state: result.order.cash_state,
      cod_status: result.order.cod_status,
      created_at: result.order.created_at,
      created_at_shopify: result.order.created_at_shopify,
      currency: result.order.currency,
      delivery_state: result.order.delivery_state,
      items_summary: result.order.items_summary,
      next_action_at: result.order.next_action_at,
      next_contact_at: result.order.next_contact_at,
      order_number: result.order.order_number,
      order_state: result.order.order_state,
      scheduled_for: result.order.scheduled_for,
      shipping_address: result.order.shipping_address,
      sort_at: result.order.sort_at,
      source: result.order.source,
      total_amount: result.order.total_amount,
      allowedActions: result.allowedActions,
    };

    onTransitionApplied?.({ nextOrder, previousOrder });

    setOrders((previous) =>
      previous.flatMap((order) => {
        if (order.id !== result.order.id) {
          return [order];
        }

        return matchesOrderSavedView(nextOrder, activeView) ? [nextOrder] : [];
      }),
    );
  }

  return (
    <section
      aria-busy={isTransitionPending ? true : undefined}
      className={cn(
        'relative space-y-3 transition-opacity motion-reduce:transition-none',
        isTransitionPending ? 'pointer-events-none opacity-60' : 'opacity-100',
      )}
      data-testid="orders-results"
    >
      {isTransitionPending ? (
        <div
          aria-hidden="true"
          className="dashboard-shimmer pointer-events-none absolute inset-0 z-10 rounded-lg opacity-60"
        />
      ) : null}

      {orders.map((order) => (
        <article
          className="rounded-lg border border-border bg-surface p-4 shadow-1 transition-colors hover:bg-canvas/50"
          key={order.id}
        >
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <Link className="min-w-0 flex-1 space-y-3" href={`/commandes/${order.id}`} prefetch>
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
              <OrderActionsMenu
                allowedActions={order.allowedActions}
                deliveryState={order.delivery_state}
                dispatchWhatsAppUrl={buildWhatsAppDispatchUrl({
                  address: formatOrderAddress(order.shipping_address),
                  currency: order.currency,
                  customerFirstName: order.customer?.full_name ?? null,
                  itemsSummary: order.items_summary,
                  orderNumber: order.order_number,
                  phone: order.customer?.phone ?? null,
                  shopName: merchantName,
                  totalAmount: order.total_amount,
                })}
                drivers={drivers}
                onTransitionSuccess={handleTransitionSuccess}
                orderId={order.id}
                phone={order.customer?.phone ?? null}
                whatsappLabels={{ confirm: 'WhatsApp', missingPhone: whatsappMissingPhoneLabel }}
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
              {canReassign && order.assigned_driver_id ? (
                <OrderDriverReassign
                  compact
                  currentDriverId={order.assigned_driver_id}
                  deliveryState={order.delivery_state}
                  drivers={drivers}
                  orderId={order.id}
                />
              ) : null}
            </div>
          </div>
        </article>
      ))}

      {hasMore && nextCursor ? (
        <div className="flex justify-center pt-2">
          <button
            className="rounded-lg border border-border bg-surface px-6 py-3 text-sm font-medium text-text hover:bg-canvas disabled:opacity-60"
            disabled={isLoadingMore || isTransitionPending}
            onClick={handleLoadMore}
            type="button"
          >
            {isLoadingMore ? 'Chargement...' : 'Voir plus'}
          </button>
        </div>
      ) : null}
    </section>
  );
}
