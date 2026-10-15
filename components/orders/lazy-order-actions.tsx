'use client';

import { PendingSpinner } from '@/components/app-shell/pending-spinner';
import type { OrderActionsMenuProps } from '@/components/orders/order-actions-menu';
import { compactMenuHasItems } from '@/lib/domain/order-menu-actions';
import { MoreHorizontal } from 'lucide-react';
import { type ComponentType, useCallback, useEffect, useState } from 'react';

// Menu « Actions » à la demande (V4). Chaque carte de la liste portait un menu complet : état,
// action serveur, dialogues, feuille de sélection (un Drawer Vaul par carte sur mobile). Elle ne
// porte plus qu'un bouton. Le menu complet n'est monté qu'au premier appui, pour UNE carte à la
// fois, et son code n'est téléchargé qu'à ce moment-là (ou dès que le doigt ou le pointeur s'en
// approche, pour que l'ouverture ne attende pas le réseau).
type MenuComponent = ComponentType<OrderActionsMenuProps>;

let loadedMenu: MenuComponent | null = null;
let pendingLoad: Promise<MenuComponent> | null = null;

/**
 * Télécharge le menu une seule fois. Un échec n'est pas retenu : l'appel suivant refait
 * l'import (webpack retente un chunk dont le téléchargement a échoué), ce qui permet de réessayer.
 */
export function loadOrderActionsMenu(): Promise<MenuComponent> {
  if (loadedMenu) return Promise.resolve(loadedMenu);
  if (!pendingLoad) {
    pendingLoad = import('@/components/orders/order-actions-menu')
      .then((module) => {
        loadedMenu = module.OrderActionsMenu;
        return module.OrderActionsMenu;
      })
      .catch((error: unknown) => {
        pendingLoad = null;
        throw error;
      });
  }
  return pendingLoad;
}

/** Lance le téléchargement du menu sans le monter. Un échec ici est silencieux : l'appui réessaie. */
export function preloadOrderActionsMenu() {
  void loadOrderActionsMenu().catch(() => undefined);
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
  /** Libellé pendant le téléchargement du menu. */
  loadingLabel: string;
  /** Libellé quand le téléchargement a échoué : dit quoi faire (réessayer). */
  retryLabel: string;
  mounted: boolean;
  onActivate: () => void;
  onBusyChange: (busy: boolean) => void;
};

export function LazyOrderActions({
  label,
  loadingLabel,
  retryLabel,
  mounted,
  onActivate,
  onBusyChange,
  ...menuProps
}: Props) {
  const [Menu, setMenu] = useState<MenuComponent | null>(() => loadedMenu);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Le code arrive après l'appui : tant qu'il n'est pas là, le MÊME bouton reste (focus conservé),
  // marqué occupé ; s'il n'arrive pas, il propose de réessayer. Un second appui ne bascule rien.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` relance volontairement le téléchargement après un échec.
  useEffect(() => {
    if (!mounted || Menu) return;
    let cancelled = false;
    setFailed(false);
    loadOrderActionsMenu().then(
      (loaded) => {
        if (!cancelled) setMenu(() => loaded);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [mounted, Menu, attempt]);

  // Même règle que le menu complet : sans entrée à montrer, la carte n'a pas de bouton.
  if (!compactMenuHasItems(menuProps.allowedActions, menuProps.phone)) {
    return null;
  }

  if (mounted && Menu) {
    return <Menu {...menuProps} compact defaultOpen onBusyChange={onBusyChange} />;
  }

  const waiting = mounted && !failed;

  return (
    <button
      aria-busy={waiting || undefined}
      aria-label={failed ? retryLabel : waiting ? loadingLabel : label}
      className={`inline-flex size-12 items-center justify-center rounded-md hover:bg-canvas hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${failed ? 'text-danger' : 'text-muted'}`}
      data-state={failed ? 'error' : waiting ? 'loading' : 'idle'}
      data-testid="order-actions-trigger"
      onClick={() => {
        if (failed) {
          setAttempt((current) => current + 1);
          return;
        }
        if (waiting) return;
        onActivate();
      }}
      onFocus={preloadOrderActionsMenu}
      onPointerEnter={preloadOrderActionsMenu}
      onTouchStart={preloadOrderActionsMenu}
      type="button"
    >
      {waiting ? (
        <PendingSpinner className="size-4" />
      ) : (
        <MoreHorizontal aria-hidden="true" className="size-4" />
      )}
    </button>
  );
}
