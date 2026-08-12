'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

const STORAGE_KEY = 'teer.tableau.period';

export function TableauPeriodPersistence({ storeId }: { storeId: string }) {
  const router = useRouter();
  const params = useSearchParams();

  useEffect(() => {
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

      if (next.toString() !== (shop ? `shop=${shop}` : '')) {
        router.replace(`/s/${storeId}/tableau?${next.toString()}`);
      }
    } catch {
      // entrée corrompue → on ignore
    }
  }, [params, router, storeId]);

  return null;
}
