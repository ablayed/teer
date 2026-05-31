'use client';

import { OrderDetailPanel } from '@/components/orders/order-detail-panel';
import type { OrderDetail, OrderTimelineEvent } from '@/lib/actions/orders';
import { AnimatePresence, motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

type OrderSideSheetProps = {
  order: OrderDetail;
  timeline: OrderTimelineEvent[];
};

const sheetTransition = {
  duration: 0.25,
  ease: [0.22, 1, 0.36, 1],
} as const;

export function OrderSideSheet({ order, timeline }: OrderSideSheetProps) {
  const router = useRouter();

  function close() {
    router.push('/commandes');
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        close();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });

  return (
    <AnimatePresence>
      <motion.div
        animate={{ opacity: 1 }}
        className="fixed inset-0 z-50 bg-black/40"
        exit={{ opacity: 0 }}
        initial={{ opacity: 0 }}
        transition={sheetTransition}
      >
        <button
          aria-label="Fermer"
          className="absolute inset-0 size-full cursor-default"
          onClick={close}
          type="button"
        />
        <motion.dialog
          animate={{ x: 0 }}
          aria-modal="true"
          className="absolute inset-y-0 right-0 flex w-full bg-surface shadow-2 outline-none sm:max-w-[480px]"
          exit={{ x: '100%' }}
          initial={{ x: '100%' }}
          open
          transition={sheetTransition}
        >
          <OrderDetailPanel mode="sheet" onClose={close} order={order} timeline={timeline} />
        </motion.dialog>
      </motion.div>
    </AnimatePresence>
  );
}
