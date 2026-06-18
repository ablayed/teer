'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

type ShopFilterPersistenceProps = {
  storageKey: string;
};

export function ShopFilterPersistence({ storageKey }: ShopFilterPersistenceProps) {
  const pathname = usePathname();
  const router = useRouter();
  const params = useSearchParams();

  useEffect(() => {
    const shop = params.get('shop');

    if (shop) {
      try {
        window.localStorage.setItem(storageKey, shop);
      } catch {
        // stockage indisponible : le filtre reste porté par l'URL
      }
      return;
    }

    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(storageKey);
    } catch {
      return;
    }

    if (!saved) {
      return;
    }

    const next = new URLSearchParams(params.toString());
    next.set('shop', saved);
    router.replace(`${pathname}?${next.toString()}`);
  }, [params, pathname, router, storageKey]);

  return null;
}
