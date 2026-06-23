'use client';

import { OrdersPageLoader } from '@/components/orders/orders-page-loader';
import { OrdersSearchInput } from '@/components/orders/orders-search-input';
import { OrdersViewChips } from '@/components/orders/orders-view-chips';
import type { DriverOption } from '@/components/orders/transition-dialog';
import type { ActiveDriverOption } from '@/lib/actions/drivers';
import type { OrderListCursor, OrderListItem } from '@/lib/actions/orders';
import {
  type OrderSavedViewId,
  applyOrderSavedViewCountTransition,
} from '@/lib/domain/order-saved-views';
import { normalizeOrderSearch } from '@/lib/orders/search';
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

const SEARCH_DEBOUNCE_MS = 280;

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
  const [localSearchQuery, setLocalSearchQuery] = useState(searchQuery);
  const [isTransitionPending, startTransition] = useTransition();
  const [isSearchPending, startSearchTransition] = useTransition();

  const displayedView = pendingViewId ?? activeView;
  const isBusy = isTransitionPending || isSearchPending || pendingViewId !== null;
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

  useEffect(() => {
    if (normalizeOrderSearch(searchQuery) === normalizeOrderSearch(localSearchQuery)) {
      return;
    }

    const activeElement = document.activeElement;
    const isSearchFieldFocused =
      activeElement instanceof HTMLInputElement && activeElement.type === 'search';

    if (isSearchFieldFocused) {
      return;
    }

    setLocalSearchQuery(searchQuery);
  }, [localSearchQuery, searchQuery]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const nextParams = new URLSearchParams(window.location.search);
      // Guard idempotent : on compare les recherches NORMALISEES (trim + lowercase, comme
      // le matching serveur). Si l'URL est deja equivalente a la saisie courante, aucun
      // router.replace ne part. Sinon on pousse la recherche debouncée en transition.
      const currentValue = normalizeOrderSearch(nextParams.get('q'));
      const normalizedValue = normalizeOrderSearch(localSearchQuery);

      if (normalizedValue === currentValue) {
        return;
      }

      if (normalizedValue) {
        nextParams.set('q', normalizedValue);
      } else {
        nextParams.delete('q');
      }

      const nextUrl = nextParams.toString() ? `${pathname}?${nextParams.toString()}` : pathname;
      startSearchTransition(() => {
        router.replace(nextUrl, { scroll: false });
      });
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [localSearchQuery, pathname, router]);

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
      <OrdersSearchInput onValueChange={setLocalSearchQuery} value={localSearchQuery} />

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
        localSearchQuery={localSearchQuery}
        merchantName={merchantName}
        onTransitionApplied={({ nextOrder, previousOrder }) => {
          setDisplayedViews((currentViews) =>
            applyOrderSavedViewCountTransition(currentViews, previousOrder, nextOrder),
          );
        }}
        reliabilityLabels={reliabilityLabels}
        selectedShopId={selectedShopId}
        serverSearchQuery={searchQuery}
        whatsappMissingPhoneLabel={whatsappMissingPhoneLabel}
      />
    </div>
  );
}
