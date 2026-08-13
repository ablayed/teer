'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

const STORAGE_KEY = 'teer.finances.period';

// Persiste le dernier filtre de période choisi (§3.2). Quand on revient sur
// /finances SANS paramètre de période (ex. lien « Finances » de la nav), on
// restaure le dernier choix ; sinon on enregistre le choix courant. Le restore
// ne se déclenche qu'en l'absence totale de période dans l'URL → pas de boucle.
export function FinancePeriodPersistence({
  activeTab,
  storeId,
}: {
  activeTab: string;
  storeId: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  useEffect(() => {
    if (pathname !== `/s/${storeId}/finances`) {
      return;
    }

    const period = params.get('period');
    const from = params.get('from');
    const to = params.get('to');
    const hasPeriod = Boolean(period || (from && to));

    if (hasPeriod) {
      const payload = period ? { period } : { from, to };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch {
        // stockage indisponible (mode privé) → on ignore
      }
      return;
    }

    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      return;
    }
    if (!saved) {
      return;
    }

    try {
      const parsed = JSON.parse(saved) as { from?: string; period?: string; to?: string };
      const next = new URLSearchParams();
      next.set('tab', activeTab);
      const shop = params.get('shop');
      if (shop) {
        next.set('shop', shop);
      }
      if (parsed.period) {
        next.set('period', parsed.period);
      }
      if (parsed.from && parsed.to) {
        next.set('from', parsed.from);
        next.set('to', parsed.to);
      }
      if (next.toString() !== `tab=${activeTab}`) {
        router.replace(`/s/${storeId}/finances?${next.toString()}`);
      }
    } catch {
      // entrée corrompue → on ignore
    }
  }, [activeTab, params, pathname, router, storeId]);

  return null;
}
