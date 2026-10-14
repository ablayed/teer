'use client';

import type { OrderActionsMenuProps } from '@/components/orders/order-actions-menu';
import { compactMenuHasItems } from '@/lib/domain/order-menu-actions';
import { MoreHorizontal } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useCallback, useState } from 'react';

// Menu « Actions » à la demande (V4). Chaque carte de la liste portait un menu complet : état,
// action serveur, dialogues, feuille de sélection (un Drawer Vaul par carte sur mobile). Elle ne
// porte plus qu'un bouton. Le menu complet n'est monté qu'au premier appui, pour UNE carte à la
// fois, et son code n'est téléchargé qu'à ce moment-là (ou dès que le doigt ou le pointeur s'en
// approche, pour que l'ouverture ne attende pas le réseau).
const loadMenu = () =>
  import('@/components/orders/order-actions-menu').then((m) => m.OrderActionsMenu);
const OrderActionsMenu = dynamic(loadMenu, { ssr: false });

/** Lance le téléchargement du menu sans le monter. */
export function preloadOrderActionsMenu() {
  void loadMenu();
}

/**
 * Quelle carte a son menu monté. Une seule est « active » ; une carte dont la transition est en
 * cours le reste jusqu'à sa fin, sinon son résultat (mise à jour de la liste) serait perdu.
 */
export function useActiveOrderMenu() {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());

  const setBusy = useCallback((orderId: string, busy: boolean) => {
    setBusyIds((current) => {
      if (current.has(orderId) === busy) return current;
      const next = new Set(current);
      if (busy) next.add(orderId);
      else next.delete(orderId);
      return next;
    });
  }, []);

  return {
    activate: setActiveId,
    isMounted: (orderId: string) => orderId === activeId || busyIds.has(orderId),
    setBusy,
  };
}

type Props = Omit<OrderActionsMenuProps, 'compact' | 'defaultOpen' | 'onBusyChange'> & {
  /** Libellé du bouton (déjà traduit par l'appelant). */
  label: string;
  mounted: boolean;
  onActivate: () => void;
  onBusyChange: (busy: boolean) => void;
};

export function LazyOrderActions({
  label,
  mounted,
  onActivate,
  onBusyChange,
  ...menuProps
}: Props) {
  // Même règle que le menu complet : sans entrée à montrer, la carte n'a pas de bouton.
  if (!compactMenuHasItems(menuProps.allowedActions, menuProps.phone)) {
    return null;
  }

  if (mounted) {
    return <OrderActionsMenu {...menuProps} compact defaultOpen onBusyChange={onBusyChange} />;
  }

  return (
    <button
      aria-label={label}
      className="inline-flex size-12 items-center justify-center rounded-md text-muted hover:bg-canvas hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="order-actions-trigger"
      onClick={onActivate}
      onFocus={preloadOrderActionsMenu}
      onPointerEnter={preloadOrderActionsMenu}
      onTouchStart={preloadOrderActionsMenu}
      type="button"
    >
      <MoreHorizontal aria-hidden="true" className="size-4" />
    </button>
  );
}
