'use client';

import { OrderDetailPanel } from '@/components/orders/order-detail-panel';
import type { DriverOption } from '@/components/orders/transition-dialog';
import { useMediaQuery } from '@/components/period-picker/use-media-query';
import type { OrderDetail } from '@/lib/actions/orders';
import { AnimatePresence, motion } from 'framer-motion';
import { usePathname, useRouter } from 'next/navigation';
import { type MouseEvent, useCallback, useEffect, useState } from 'react';

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
  // UX-COD-01 §4 — la spec exige "une page dédiée, pas un panneau bas" sur téléphone.
  // L'interception de route Next.js n'est PAS sensible au viewport (elle intercepte toute
  // navigation douce, quelle que soit la largeur) : c'est donc CE composant qui décide,
  // sous `md`, de rendre le même JSX que la route directe (`app/(app)/commandes/[id]/
  // page.tsx`, mode="page") plutôt que le dialog/scrim. Même hook que PeriodPicker
  // (`components/period-picker/period-picker.tsx`), même garde `mounted` : SSR/premier
  // rendu client = `false`, pas de divergence d'hydratation.
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const close = useCallback(() => {
    router.back();
  }, [router]);

  function keepSheetOpen(event: MouseEvent) {
    event.stopPropagation();
  }

  useEffect(() => {
    if (!isDesktop) {
      return;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        close();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [close, isDesktop]);

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

  // Avant montage : rien — on ne sait pas encore si c'est mobile ou desktop, et cette
  // route interceptée n'est jamais présente au premier rendu SSR (elle n'existe qu'après
  // une navigation douce cliente), donc pas de flash de contenu perdu.
  if (!mounted) {
    return null;
  }

  if (!isDesktop) {
    return (
      <main id="main">
        <OrderDetailPanel
          canEditAmounts={canEditAmounts}
          drivers={drivers}
          mode="page"
          order={order}
        />
      </main>
    );
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
