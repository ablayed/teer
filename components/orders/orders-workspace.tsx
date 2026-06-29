'use client';

import { useOrdersBoard } from '@/components/orders/orders-board-context';
import { OrdersPageLoader } from '@/components/orders/orders-page-loader';
import { OrdersSearchInput } from '@/components/orders/orders-search-input';
import { OrdersViewChips } from '@/components/orders/orders-view-chips';
import type { DriverOption } from '@/components/orders/transition-dialog';
import type { ActiveDriverOption } from '@/lib/actions/drivers';
import { type OrderListCursor, type OrderListItem, getOrdersPageData } from '@/lib/actions/orders';
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
  activePeriod: string;
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
  reliabilityLabels: Record<ReliabilityTier, string>;
  searchQuery: string;
  selectedShopId: string | null;
  views: OrderViewCount[];
};

const SEARCH_DEBOUNCE_MS = 280;

export function OrdersWorkspace({
  activePeriod,
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
  reliabilityLabels,
  searchQuery,
  selectedShopId,
  views,
}: OrdersWorkspaceProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pendingViewId, setPendingViewId] = useState<OrderSavedViewId | null>(null);
  const [displayedViews, setDisplayedViews] = useState(views);
  const [localSearchQuery, setLocalSearchQuery] = useState(searchQuery);
  const [isTransitionPending, startTransition] = useTransition();
  const [isSearchPending, startSearchTransition] = useTransition();
  const board = useOrdersBoard();
  // Paradigm A (PR #17) : après création, on relit la liste FRAÎCHE côté serveur et on
  // la stocke ici, en surcouche des props issues du RSC — qui, post-navigation, étaient
  // ~20 % du temps périmées en build prod (commande créée invisible). L'injection bascule
  // l'affichage sur « Toutes » ; elle est purgée dès la prochaine vraie navigation.
  const [injectedView, setInjectedView] = useState<{
    hasMore: boolean;
    nextCursor: OrderListCursor | null;
    orders: OrderListItem[];
    reliabilityTiers: Record<string, ReliabilityTier>;
    viewCounts: Record<OrderSavedViewId, number>;
  } | null>(null);

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

  // Purge l'injection UNIQUEMENT sur une vraie navigation (vue / période / boutique /
  // recherche → ces props changent). PAS sur le refresh implicite que Next déclenche
  // après notre PROPRE server action (getOrdersPageData) : celui-ci ne change que
  // `views`/`initialOrders` — s'il purgeait l'injection, il effacerait la liste fraîche
  // qu'on vient d'injecter (et resservirait le RSC périmé). C'est ce qui rendait le bug.
  // Reset on navigation : le corps ne LIT pas ces deps, il réinitialise l'injection dès
  // que vue / période / boutique / recherche change — c'est l'intention recherchée.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps = signal de navigation volontaire
  useEffect(() => {
    setInjectedView(null);
  }, [activeView, activePeriod, selectedShopId, searchQuery]);

  // Enregistre le rafraîchisseur déclenché par NewOrderForm après création (frère via
  // le contexte). Relit getOrdersPageData(vue=toutes) — MÊME source serveur que le RSC —
  // et l'injecte dans le state, sans navigation ni router.refresh().
  useEffect(() => {
    if (!board) {
      return;
    }
    return board.registerRefresh((createdOrderId) => {
      setPendingViewId(null);
      setLocalSearchQuery('');
      startTransition(async () => {
        // Poll borné : la commande est committée (l'action l'a attendue), mais une
        // relecture immédiate la rate par intermittence (visibilité read-after-write
        // de la stack locale). On relit — avec une borne haute FRAÎCHE (le `dateTo` prop
        // est figé à `now` AVANT création → orderMatchesPeriod exclurait la commande) —
        // jusqu'à voir l'id créé, puis on injecte. Principe expect.poll : on attend une
        // donnée réelle, on ne masque rien.
        let fresh = await getOrdersPageData({
          dateFrom,
          dateTo: new Date().toISOString(),
          search: '',
          shopId: selectedShopId,
          view: 'toutes',
        });
        for (let attempt = 0; attempt < 12; attempt += 1) {
          if (fresh.orders.some((order) => order.id === createdOrderId)) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
          fresh = await getOrdersPageData({
            dateFrom,
            dateTo: new Date().toISOString(),
            search: '',
            shopId: selectedShopId,
            view: 'toutes',
          });
        }
        setInjectedView({
          hasMore: fresh.hasMore,
          nextCursor: fresh.nextCursor,
          orders: fresh.orders,
          reliabilityTiers: fresh.reliabilityTiers as Record<string, ReliabilityTier>,
          viewCounts: fresh.viewCounts,
        });
      });
    });
  }, [board, dateFrom, selectedShopId]);

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
    // Un clic de chip reprend le modèle navigation : on purge l'injection (et on navigue
    // même si la vue affichée == cible, pour resynchroniser l'URL masquée par l'injection).
    const hadInjection = injectedView !== null;
    setInjectedView(null);

    if (!hadInjection && viewId === displayedView) {
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

  // Surcouche injection : quand une création vient d'avoir lieu, on affiche « Toutes »
  // avec les données fraîches relues côté serveur, sans dépendre du RSC post-navigation.
  const effectiveView: OrderSavedViewId = injectedView ? 'toutes' : displayedView;
  const effectiveViews = injectedView
    ? displayedViews.map((view) => ({ ...view, count: injectedView.viewCounts[view.id] }))
    : displayedViews;
  const effectiveOrders = injectedView?.orders ?? initialOrders;
  const effectiveHasMore = injectedView?.hasMore ?? initialHasMore;
  const effectiveNextCursor = injectedView?.nextCursor ?? initialNextCursor;
  const effectiveReliability = injectedView?.reliabilityTiers ?? initialReliabilityTiers;

  return (
    <div className="space-y-4">
      <OrdersSearchInput onValueChange={setLocalSearchQuery} value={localSearchQuery} />

      <OrdersViewChips
        activeView={effectiveView}
        onSelect={handleSelect}
        pendingViewId={pendingViewId}
        views={effectiveViews}
      />

      <OrdersPageLoader
        activeView={effectiveView}
        canReassign={canReassign}
        dateFrom={dateFrom}
        dateTo={dateTo}
        drivers={driverOptions}
        emptyValueLabel={emptyValueLabel}
        initialHasMore={effectiveHasMore}
        initialNextCursor={effectiveNextCursor}
        initialOrders={effectiveOrders}
        initialReliabilityTiers={effectiveReliability}
        isTransitionPending={isBusy}
        localSearchQuery={localSearchQuery}
        onTransitionApplied={({ nextOrder, previousOrder }) => {
          setDisplayedViews((currentViews) =>
            applyOrderSavedViewCountTransition(currentViews, previousOrder, nextOrder),
          );
        }}
        reliabilityLabels={reliabilityLabels}
        selectedShopId={selectedShopId}
        serverSearchQuery={searchQuery}
      />
    </div>
  );
}
