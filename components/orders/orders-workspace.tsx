'use client';

import { useOrdersBoard } from '@/components/orders/orders-board-context';
import { OrdersPageLoader } from '@/components/orders/orders-page-loader';
import { OrdersViewChips } from '@/components/orders/orders-view-chips';
import type { DriverOption } from '@/components/orders/transition-dialog';
import { SearchInput } from '@/components/ui/search-input';
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

type OrdersOverlay = {
  hasMore: boolean;
  nextCursor: OrderListCursor | null;
  orders: OrderListItem[];
  reliabilityTiers: Record<string, ReliabilityTier>;
  viewCounts: Record<OrderSavedViewId, number>;
};

type SearchLabels = {
  ariaLabel: string;
  clear: string;
  placeholder: string;
};

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
  searchLabels: SearchLabels;
  searchQuery: string;
  selectedShopId: string | null;
  views: OrderViewCount[];
};

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
  searchLabels,
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
  const [injectedView, setInjectedView] = useState<OrdersOverlay | null>(null);
  // Paradigm A pour la RECHERCHE : la synchro d'URL passe en shallow (history.replaceState,
  // pas de navigation → pas de scroll-jump), donc le RSC ne refait PAS le filtrage serveur.
  // On relit nous-mêmes `getOrdersPageData(search)` — MÊME source serveur, MÊME scoping
  // période/boutique, MÊME pagination (25) — et on injecte le résultat ici. Sans ça, la
  // recherche ne couvrirait que les 25 commandes déjà chargées (régression au-delà de la
  // page 1). Le filtrage mémoire instantané (localSearchQuery) reste la couche réactive.
  const [searchResult, setSearchResult] = useState<(OrdersOverlay & { search: string }) | null>(
    null,
  );

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

  // Purge les surcouches UNIQUEMENT sur une vraie navigation de filtre (vue / période /
  // boutique → ces props changent). PAS sur le refresh implicite que Next déclenche après
  // notre PROPRE server action (getOrdersPageData) : celui-ci ne change que
  // `views`/`initialOrders` — s'il purgeait la surcouche, il effacerait la liste fraîche
  // qu'on vient d'injecter (et resservirait le RSC périmé). C'est ce qui rendait le bug.
  // `searchQuery` est volontairement EXCLU des deps : la recherche met l'URL à jour en
  // shallow (history.replaceState), donc si le RSC se re-rendait avec un nouveau `?q=`, ça
  // NE doit PAS purger `searchResult` (la surcouche déterministe qu'on vient d'injecter).
  // Reset on navigation : le corps ne LIT pas ces deps, il réinitialise les surcouches dès
  // que vue / période / boutique change — c'est l'intention recherchée.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps = signal de navigation volontaire
  useEffect(() => {
    setInjectedView(null);
    setSearchResult(null);
  }, [activeView, activePeriod, selectedShopId]);

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
      setSearchResult(null);
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

  // Resynchronise la saisie locale sur la recherche SERVEUR effective quand l'utilisateur
  // n'a pas le focus (préserve la correction de race antérieure : on ne réécrit jamais le
  // champ pendant la frappe). On compare à `searchResult?.search ?? searchQuery` et NON au
  // seul `searchQuery` : avec la synchro shallow, le `?q=` du RSC ne « rattrape » plus la
  // saisie — c'est la surcouche `searchResult` qui fait foi. Sans ça, un blur après une
  // recherche stabilisée remettrait le champ à la valeur RSC (vide) et effacerait la liste.
  useEffect(() => {
    const effectiveServer = searchResult?.search ?? searchQuery;
    if (normalizeOrderSearch(effectiveServer) === normalizeOrderSearch(localSearchQuery)) {
      return;
    }

    const activeElement = document.activeElement;
    const isSearchFieldFocused =
      activeElement instanceof HTMLInputElement && activeElement.type === 'search';

    if (isSearchFieldFocused) {
      return;
    }

    setLocalSearchQuery(effectiveServer);
  }, [localSearchQuery, searchQuery, searchResult]);

  // Branché sur `SearchInput.onDebouncedChange` : la primitive a déjà synchronisé l'URL en
  // shallow (history.replaceState, sans navigation → sans scroll-jump). Ici on relit côté
  // serveur la MÊME source que le RSC (getOrdersPageData), avec le scoping période/boutique
  // courant et la vue active, puis on injecte — paradigme A. La couche mémoire instantanée
  // (localSearchQuery → filterOrdersBySearch) a déjà rafraîchi l'affichage des commandes
  // chargées ; ce refetch étend la recherche à TOUTE la période (au-delà de la page 1).
  function handleDebouncedSearch(value: string) {
    setInjectedView(null);
    startSearchTransition(async () => {
      const fresh = await getOrdersPageData({
        dateFrom,
        dateTo,
        search: value,
        shopId: selectedShopId,
        view: activeView,
      });
      setSearchResult({
        search: value,
        hasMore: fresh.hasMore,
        nextCursor: fresh.nextCursor,
        orders: fresh.orders,
        reliabilityTiers: fresh.reliabilityTiers as Record<string, ReliabilityTier>,
        viewCounts: fresh.viewCounts,
      });
    });
  }

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

  // Surcouches paradigme A (recherche prioritaire sur création — mutuellement exclusives) :
  // la recherche affiche les données relues côté serveur pour `?q=` sans dépendre d'un RSC
  // post-navigation ; la création affiche « Toutes » avec la liste fraîche post-insertion.
  const activeOverlay = searchResult ?? injectedView;
  const overlayViewCounts = searchResult?.viewCounts ?? injectedView?.viewCounts ?? null;
  const effectiveView: OrderSavedViewId = injectedView ? 'toutes' : displayedView;
  const effectiveViews = overlayViewCounts
    ? displayedViews.map((view) => ({ ...view, count: overlayViewCounts[view.id] }))
    : displayedViews;
  const effectiveOrders = activeOverlay?.orders ?? initialOrders;
  const effectiveHasMore = activeOverlay?.hasMore ?? initialHasMore;
  const effectiveNextCursor = activeOverlay?.nextCursor ?? initialNextCursor;
  const effectiveReliability = activeOverlay?.reliabilityTiers ?? initialReliabilityTiers;
  // Recherche serveur effective : tant qu'une surcouche de recherche est posée, c'est sa
  // valeur qui fait foi (sinon le `?q=` initial du RSC). Pilote `localSearchAhead` côté
  // loader : tant que la saisie devance ce refetch, on filtre en mémoire les commandes
  // affichées ; dès qu'il rattrape, on bascule sur les résultats serveur (au-delà de p.1).
  const effectiveServerSearch = searchResult?.search ?? searchQuery;

  return (
    <div className="space-y-4">
      <SearchInput
        ariaLabel={searchLabels.ariaLabel}
        clearLabel={searchLabels.clear}
        onDebouncedChange={handleDebouncedSearch}
        onValueChange={setLocalSearchQuery}
        placeholder={searchLabels.placeholder}
        value={localSearchQuery}
      />

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
        serverSearchQuery={effectiveServerSearch}
      />
    </div>
  );
}
