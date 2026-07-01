'use client';

import { OrderDetailPanel } from '@/components/orders/order-detail-panel';
import type { DriverOption } from '@/components/orders/transition-dialog';
import type { OrderDetail } from '@/lib/actions/orders';
import { AnimatePresence, motion } from 'framer-motion';
import { usePathname, useRouter } from 'next/navigation';
import { type MouseEvent, useCallback, useEffect } from 'react';

type OrderSideSheetProps = {
  canEditAmounts: boolean;
  drivers: DriverOption[];
  order: OrderDetail;
};

const sheetTransition = {
  duration: 0.25,
  ease: [0.22, 1, 0.36, 1],
} as const;

export function OrderSideSheet({ canEditAmounts, drivers, order }: OrderSideSheetProps) {
  const router = useRouter();
  const pathname = usePathname();

  const close = useCallback(() => {
    router.back();
  }, [router]);

  function keepSheetOpen(event: MouseEvent) {
    event.stopPropagation();
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        close();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [close]);

  // Fermeture déterministe : le sheet est monté dans le slot intercepté `@modal`.
  // Sur build prod + WebKit, `router.back()` remet l'URL à /commandes mais ne démonte
  // pas toujours ce slot (le scrim `fixed inset-0 z-50` reste alors bloquant, 90 s+).
  // Comme l'`exit` framer-motion ne joue pas lors d'un démontage piloté par la route,
  // on se ferme nous-mêmes dès que le pathname n'est plus la route détail — sans
  // navigation qui effacerait la recherche (cf. retrait du router.replace, 642656e).
  const isDetailRoute = /\/commandes\/[^/]+$/.test(pathname);
  if (!isDetailRoute) {
    return null;
  }

  return (
    <AnimatePresence>
      <motion.div
        animate={{ opacity: 1 }}
        className="fixed inset-0 z-50 flex justify-end overflow-hidden bg-black/40"
        exit={{ opacity: 0 }}
        initial={{ opacity: 0 }}
        onClick={close}
        transition={sheetTransition}
      >
        <motion.dialog
          animate={{ x: 0 }}
          aria-modal="true"
          className="relative m-0 flex h-dvh max-h-dvh min-h-0 w-full overflow-hidden border-0 bg-surface p-0 shadow-2 outline-none sm:max-w-[480px]"
          exit={{ x: '100%' }}
          initial={{ x: '100%' }}
          onClick={keepSheetOpen}
          open
          transition={sheetTransition}
        >
          <OrderDetailPanel
            canEditAmounts={canEditAmounts}
            drivers={drivers}
            mode="sheet"
            onClose={close}
            order={order}
          />
        </motion.dialog>
      </motion.div>
    </AnimatePresence>
  );
}
