'use client';

import { PendingSpinner } from '@/components/app-shell/pending-spinner';
import { cn } from '@/lib/utils';
import { useLinkStatus } from 'next/link';
import { useEffect, useState } from 'react';

/**
 * Indicateur de navigation « pending » (LOT PERF #4).
 *
 * Doit être rendu À L'INTÉRIEUR d'un <Link> : `useLinkStatus` lit l'état de la
 * navigation déclenchée par ce lien. Dès le tap, on affiche un petit spinner —
 * mais avec un débounce de 100ms (départ opacity:0) pour ne PAS flasher sur les
 * navigations instantanées (page en cache Router). N'apparaît qu'en build de
 * production (le prefetch/Router Cache n'existe pas en `next dev`).
 */
export function NavLinkPending({ className }: { className?: string }) {
  const { pending } = useLinkStatus();
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!pending) {
      setShown(false);
      return;
    }

    const timer = setTimeout(() => setShown(true), 100);
    return () => clearTimeout(timer);
  }, [pending]);

  return (
    <PendingSpinner
      className={cn(
        'transition-opacity duration-150',
        shown ? 'opacity-70' : 'opacity-0',
        className,
      )}
    />
  );
}
