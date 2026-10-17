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

// Intention d'ouverture reçue AVANT l'hydratation (components/orders/early-menu-intent.tsx).
declare global {
  interface Window {
    __earlyMenu?: {
      at: number;
      hydrated: boolean;
      id: string | null;
      path: string;
      reload?: () => void;
      reset?: (element: Element | null) => void;
      timer: number;
    };
  }
}

const EARLY_INTENT_MAX_AGE_MS = 15_000;

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

  // Effet du PARENT : il s'exécute après ceux des cartes, qui ont déjà repris leur intention éventuelle.
  // Les scripts ont fini par démarrer : l'état visuel posé avant l'hydratation est nettoyé et le message
  // d'échec éventuel retiré.
  useEffect(() => {
    const early = window.__earlyMenu;
    if (!early) return;
    early.hydrated = true;
    for (const element of document.querySelectorAll('[data-early-state]')) early.reset?.(element);
    document.getElementById('early-menu-failed')?.setAttribute('hidden', '');
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
  /** Libellé quand les scripts de l'application n'ont pas démarré (avant hydratation) : dit de recharger. */
  reloadLabel: string;
  mounted: boolean;
  onActivate: () => void;
  onBusyChange: (busy: boolean) => void;
};

export function LazyOrderActions({
  label,
  loadingLabel,
  retryLabel,
  reloadLabel,
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

  // Reprend l'intention d'ouverture reçue avant l'hydratation, au plus une : rejetée si elle est périmée,
  // si la page a changé, ou si ce n'est pas cette carte. `onActivate` est idempotent : aucun double
  // traitement si React a aussi rejoué le même appui.
  // biome-ignore lint/correctness/useExhaustiveDependencies: au montage seulement, c'est l'hydratation qui reprend l'intention.
  useEffect(() => {
    const early = window.__earlyMenu;
    if (!early || early.id !== menuProps.orderId) return;
    window.clearTimeout(early.timer);
    early.id = null;
    early.reset?.(document.querySelector(`[data-early-menu="${menuProps.orderId}"]`));
    const fresh = Date.now() - early.at <= EARLY_INTENT_MAX_AGE_MS;
    const samePage = early.path === `${window.location.pathname}${window.location.search}`;
    if (fresh && samePage && compactMenuHasItems(menuProps.allowedActions, menuProps.phone)) {
      onActivate();
    }
  }, []);

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
      className={`inline-flex size-12 items-center justify-center rounded-md hover:bg-canvas hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[early-state=failed]:text-danger data-[early-state=pending]:animate-pulse data-[early-state=pending]:bg-canvas ${failed ? 'text-danger' : 'text-muted'}`}
      data-early-failed-label={reloadLabel}
      data-early-idle-label={label}
      data-early-loading-label={loadingLabel}
      data-early-menu={menuProps.orderId}
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
      suppressHydrationWarning
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
