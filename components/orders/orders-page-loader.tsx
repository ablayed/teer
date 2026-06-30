'use client';

import { CodStatusListBadge } from '@/components/orders/cod-status-list-badge';
import { CustomerReliabilityBadge } from '@/components/orders/customer-reliability-badge';
import { OrderActionsMenu } from '@/components/orders/order-actions-menu';
import { OrderDriverReassign } from '@/components/orders/order-driver-reassign';
import type { DriverOption } from '@/components/orders/transition-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { ResourceRow } from '@/components/ui/resource-row';
import {
  type OrderListCursor,
  type OrderListItem,
  loadMoreOrdersAction,
} from '@/lib/actions/orders';
import type { TransitionResult } from '@/lib/actions/transitions';
import { matchesOrderSavedView, orderQueueDate } from '@/lib/domain/order-saved-views';
import type { OrderSavedViewId } from '@/lib/domain/order-saved-views';
import type { OrderStatus } from '@/lib/domain/order-state-machine';
import { formatDateDayKey, formatDateGroupLabel, formatDateRelative } from '@/lib/format/date';
import { formatMoney } from '@/lib/format/fcfa';
import { formatOrderAddress } from '@/lib/format/order-address';
import { filterOrdersBySearch, normalizeOrderSearch } from '@/lib/orders/search';
import { cn } from '@/lib/utils';
import { type WhatsappOrderData, parseItemsSummaryForWhatsapp } from '@/lib/whatsapp/format';
import { useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';

type ReliabilityTier = 'new' | 'reliable' | 'risk' | 'watch';
type TransitionSuccess = Extract<TransitionResult, { ok: true }>;

type Props = {
  activeView: OrderSavedViewId;
  canReassign: boolean;
  dateFrom: string;
  dateTo: string;
  drivers: DriverOption[];
  emptyValueLabel: string;
  initialHasMore: boolean;
  initialNextCursor: OrderListCursor | null;
  initialOrders: OrderListItem[];
  initialReliabilityTiers: Record<string, ReliabilityTier>;
  isTransitionPending: boolean;
  localSearchQuery: string;
  reliabilityLabels: Record<ReliabilityTier, string>;
  selectedShopId: string | null;
  serverSearchQuery: string;
  onTransitionApplied?: (event: {
    nextOrder: OrderListItem;
    previousOrder: OrderListItem;
  }) => void;
};

export function OrdersPageLoader({
  activeView,
  canReassign,
  dateFrom,
  dateTo,
  drivers,
  emptyValueLabel,
  initialHasMore,
  initialNextCursor,
  initialOrders,
  initialReliabilityTiers,
  isTransitionPending,
  localSearchQuery,
  reliabilityLabels,
  selectedShopId,
  serverSearchQuery,
  onTransitionApplied,
}: Props) {
  const t = useTranslations('orders');
  const [orders, setOrders] = useState(initialOrders);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [reliabilityTiers, setReliabilityTiers] = useState(initialReliabilityTiers);
  const [isLoadingMore, startTransition] = useTransition();
  const normalizedSearch = normalizeOrderSearch(localSearchQuery);
  const localSearchAhead = normalizedSearch !== normalizeOrderSearch(serverSearchQuery);
  const visibleOrders = filterOrdersBySearch(orders, localSearchQuery);
  // État vide géré côté client : la synchro d'URL étant shallow (history.replaceState), le
  // RSC ne re-rend plus l'état vide serveur lors d'une recherche en page. On l'affiche donc
  // ici, mais SEULEMENT une fois le refetch serveur retombé (pas pendant que la saisie
  // devance le refetch, ni pendant le pending) — sinon on annoncerait « aucun résultat »
  // alors qu'une commande au-delà de la page 1 peut encore arriver.
  const showSearchEmpty =
    normalizedSearch.length > 0 &&
    !localSearchAhead &&
    !isTransitionPending &&
    visibleOrders.length === 0;
  const groupedOrders = visibleOrders.reduce<
    Array<{ dayKey: string; label: string; orders: OrderListItem[] }>
  >((groups, order) => {
    const groupValue = orderQueueDate(order);
    const dayKey = formatDateDayKey(groupValue);
    const currentGroup = groups.at(-1);

    if (!currentGroup || currentGroup.dayKey !== dayKey) {
      groups.push({
        dayKey,
        label: formatDateGroupLabel(groupValue),
        orders: [order],
      });
      return groups;
    }

    currentGroup.orders.push(order);
    return groups;
  }, []);

  useEffect(() => {
    if (localSearchAhead) {
      return;
    }

    setOrders(initialOrders);
    setHasMore(initialHasMore);
    setNextCursor(initialNextCursor);
    setReliabilityTiers(initialReliabilityTiers);
  }, [initialHasMore, initialNextCursor, initialOrders, initialReliabilityTiers, localSearchAhead]);

  function handleLoadMore() {
    if (!nextCursor || localSearchAhead) {
      return;
    }

    startTransition(async () => {
      const result = await loadMoreOrdersAction({
        cursor: nextCursor,
        dateFrom,
        dateTo,
        search: serverSearchQuery,
        shopId: selectedShopId,
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

      {groupedOrders.map((group) => (
        <div className="space-y-3" key={group.dayKey}>
          <h2 className="px-1 text-sm font-semibold uppercase tracking-wide text-muted">
            {group.label}
          </h2>
          {group.orders.map((order) => (
            <article
              className="rounded-lg border border-border bg-surface shadow-1 transition-colors hover:bg-canvas/50"
              key={order.id}
            >
              <ResourceRow
                href={`/commandes/${order.id}`}
                meta={
                  <span className="inline-flex flex-wrap items-center gap-x-1.5">
                    <span className="font-mono">{order.order_number ?? emptyValueLabel}</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatDateRelative(order.created_at_shopify ?? order.created_at)}</span>
                    <span className="@min-[22rem]/row:inline hidden" data-testid="order-row-amount">
                      <span aria-hidden="true" className="mr-1.5">
                        ·
                      </span>
                      <span className="font-medium text-text">
                        {formatMoney(order.total_amount, order.currency)}
                      </span>
                    </span>
                  </span>
                }
                overflow={
                  <div className="flex items-center gap-1">
                    <OrderActionsMenu
                      allowedActions={order.allowedActions}
                      canEditAmounts={canReassign}
                      compact
                      deliveryState={order.delivery_state}
                      drivers={drivers}
                      onTransitionSuccess={handleTransitionSuccess}
                      orderId={order.id}
                      phone={order.customer?.phone ?? null}
                      whatsappOrderData={{
                        numeroCommande: order.order_number,
                        telephone: order.customer?.phone ?? null,
                        adresse: formatOrderAddress(order.shipping_address),
                        total: order.total_amount,
                        items: parseItemsSummaryForWhatsapp(order.items_summary),
                      }}
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
                }
                status={
                  <CodStatusListBadge
                    deliveryState={order.delivery_state}
                    status={order.cod_status as OrderStatus}
                  />
                }
                title={
                  <span className="flex min-w-0 items-center gap-1.5" data-testid="order-row-title">
                    <span className="truncate">{order.customer?.full_name ?? emptyValueLabel}</span>
                    <CustomerReliabilityBadge
                      labels={reliabilityLabels}
                      tier={
                        order.customer_id ? (reliabilityTiers[order.customer_id] ?? null) : null
                      }
                    />
                  </span>
                }
              />
            </article>
          ))}
        </div>
      ))}

      {showSearchEmpty ? (
        <EmptyState
          description={t('search.emptyDescription')}
          title={t('search.emptyTitle', { query: localSearchQuery.trim() })}
        />
      ) : null}

      {!localSearchAhead && hasMore && nextCursor ? (
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
