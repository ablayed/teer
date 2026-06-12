'use client';

import { OrderDetailPanel } from '@/components/orders/order-detail-panel';
import type { DriverOption } from '@/components/orders/transition-dialog';
import type { OrderDetail } from '@/lib/actions/orders';
import { AnimatePresence, motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { type MouseEvent, useCallback, useEffect } from 'react';

type OrderSideSheetProps = {
  drivers: DriverOption[];
  order: OrderDetail;
  shopName: string;
  whatsappLabels: {
    confirm: string;
    missingPhone: string;
  };
};

const sheetTransition = {
  duration: 0.25,
  ease: [0.22, 1, 0.36, 1],
} as const;

export function OrderSideSheet({ drivers, order, shopName, whatsappLabels }: OrderSideSheetProps) {
  const router = useRouter();

  const close = useCallback(() => {
    router.back();
    window.setTimeout(() => {
      router.replace('/commandes');
    }, 150);
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
            drivers={drivers}
            mode="sheet"
            onClose={close}
            order={order}
            shopName={shopName}
            whatsappLabels={whatsappLabels}
          />
        </motion.dialog>
      </motion.div>
    </AnimatePresence>
  );
}
