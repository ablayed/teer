'use client';

import { OrdersPageLoader } from '@/components/orders/orders-page-loader';
import { OrdersViewChips } from '@/components/orders/orders-view-chips';
import type { DriverOption } from '@/components/orders/transition-dialog';
import type { ActiveDriverOption } from '@/lib/actions/drivers';
import type { OrderListCursor, OrderListItem } from '@/lib/actions/orders';
import {
  type OrderSavedViewId,
  applyOrderSavedViewCountTransition,
} from '@/lib/domain/order-saved-views';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';

type OrderViewCount = {
  count: number;
  id: OrderSavedViewId;
  label: string;
};

type ReliabilityTier = 'new' | 'reliable' | 'risk' | 'watch';

type OrdersWorkspaceProps = {
  activeView: OrderSavedViewId;
  canReassign: boolean;
  dateFrom: string;
  dateTo: string;
  drivers: ActiveDriverOption[];
  emptyValueLabel: string;
  initialHasMore: boolean;
  initialNextCursor: OrderListCursor | null;
  initialOrders: OrderListItem[];
  initialReliabilityTiers: Record<string, ReliabilityTier>;
  merchantName: string;
  reliabilityLabels: Record<ReliabilityTier, string>;
  searchQuery: string;
  selectedShopId: string | null;
  views: OrderViewCount[];
  whatsappMissingPhoneLabel: string;
};

export function OrdersWorkspace({
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
  merchantName,
  reliabilityLabels,
  searchQuery,
  selectedShopId,
  views,
  whatsappMissingPhoneLabel,
}: OrdersWorkspaceProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pendingViewId, setPendingViewId] = useState<OrderSavedViewId | null>(null);
  const [displayedViews, setDisplayedViews] = useState(views);
  const [isTransitionPending, startTransition] = useTransition();

  const displayedView = pendingViewId ?? activeView;
  const isBusy = isTransitionPending || pendingViewId !== null;
  const driverOptions: DriverOption[] = drivers.map((driver) => ({
    id: driver.id,
    fullName: driver.fullName,
  }));

  useEffect(() => {
    if (pendingViewId !== null && pendingViewId === activeView) {
      setPendingViewId(null);
    }
  }, [activeView, pendingViewId]);

  useEffect(() => {
    setDisplayedViews(views);
  }, [views]);

  function handleSelect(viewId: OrderSavedViewId) {
    if (viewId === displayedView) {
      return;
    }

    const nextParams = new URLSearchParams(searchParams.toString());

    if (viewId === 'toutes') {
      nextParams.delete('vue');
    } else {
      nextParams.set('vue', viewId);
    }

    const query = nextParams.toString();
    setPendingViewId(viewId);
    startTransition(() => {
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    });
  }

  return (
    <div className="space-y-4">
      <OrdersViewChips
        activeView={displayedView}
        onSelect={handleSelect}
        pendingViewId={pendingViewId}
        views={displayedViews}
      />

      <OrdersPageLoader
        activeView={displayedView}
        canReassign={canReassign}
        dateFrom={dateFrom}
        dateTo={dateTo}
        drivers={driverOptions}
        emptyValueLabel={emptyValueLabel}
        initialHasMore={initialHasMore}
        initialNextCursor={initialNextCursor}
        initialOrders={initialOrders}
        initialReliabilityTiers={initialReliabilityTiers}
        isTransitionPending={isBusy}
        merchantName={merchantName}
        onTransitionApplied={({ nextOrder, previousOrder }) => {
          setDisplayedViews((currentViews) =>
            applyOrderSavedViewCountTransition(currentViews, previousOrder, nextOrder),
          );
        }}
        reliabilityLabels={reliabilityLabels}
        searchQuery={searchQuery}
        selectedShopId={selectedShopId}
        whatsappMissingPhoneLabel={whatsappMissingPhoneLabel}
      />
    </div>
  );
}
