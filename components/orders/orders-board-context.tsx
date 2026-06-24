'use client';

import { type ReactNode, createContext, useCallback, useContext, useMemo, useRef } from 'react';

/**
 * Pont client entre `NewOrderForm` (dans l'en-tête) et `OrdersWorkspace` (la liste),
 * qui sont des frères sous la page RSC. Après une création, le formulaire notifie ;
 * le workspace relit la liste FRAÎCHE côté serveur (getOrdersPageData) et la réinjecte
 * dans son state — Paradigm A (PR #17) : aucune dépendance au Router Cache / RSC caché,
 * dont le re-render post-navigation était racé (~20 % de commandes invisibles en build prod).
 */
type OrdersBoardContextValue = {
  // Le workspace enregistre son rafraîchisseur ; renvoie une fonction de désinscription.
  registerRefresh: (handler: (createdOrderId: string) => void) => () => void;
  // Le formulaire le déclenche après création ; renvoie true si un rafraîchisseur a tourné.
  notifyOrderCreated: (createdOrderId: string) => boolean;
};

const OrdersBoardContext = createContext<OrdersBoardContextValue | null>(null);

export function OrdersBoardProvider({ children }: { children: ReactNode }) {
  const handlerRef = useRef<((createdOrderId: string) => void) | null>(null);

  const registerRefresh = useCallback((handler: (createdOrderId: string) => void) => {
    handlerRef.current = handler;
    return () => {
      if (handlerRef.current === handler) {
        handlerRef.current = null;
      }
    };
  }, []);

  const notifyOrderCreated = useCallback((createdOrderId: string) => {
    if (!handlerRef.current) {
      return false;
    }
    handlerRef.current(createdOrderId);
    return true;
  }, []);

  const value = useMemo(
    () => ({ registerRefresh, notifyOrderCreated }),
    [registerRefresh, notifyOrderCreated],
  );

  return <OrdersBoardContext.Provider value={value}>{children}</OrdersBoardContext.Provider>;
}

export function useOrdersBoard(): OrdersBoardContextValue | null {
  return useContext(OrdersBoardContext);
}
