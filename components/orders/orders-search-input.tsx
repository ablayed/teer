'use client';

import { Search, X } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

type OrdersSearchInputProps = {
  initialValue: string;
};

export function OrdersSearchInput({ initialValue }: OrdersSearchInputProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    setValue(initialValue);
  }, [initialValue]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const nextParams = new URLSearchParams(window.location.search);
      const currentValue = nextParams.get('q')?.trim() ?? '';
      const normalizedValue = value.trim();

      if (normalizedValue === currentValue) {
        return;
      }

      if (normalizedValue) {
        nextParams.set('q', normalizedValue);
      } else {
        nextParams.delete('q');
      }

      const nextUrl = nextParams.toString() ? `${pathname}?${nextParams.toString()}` : pathname;
      router.replace(nextUrl, { scroll: false });
    }, 180);

    return () => window.clearTimeout(timeoutId);
  }, [pathname, router, value]);

  return (
    <label className="relative block">
      <span className="sr-only">Rechercher une commande</span>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
      />
      <input
        className="min-h-11 w-full rounded-lg border border-border bg-surface pr-12 pl-9 text-sm text-text outline-none focus:border-accent"
        onChange={(event) => setValue(event.target.value)}
        placeholder="Nom, telephone ou produit"
        type="search"
        value={value}
      />
      {value ? (
        <button
          aria-label="Effacer la recherche"
          className="absolute top-1/2 right-1 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded-lg text-muted hover:bg-canvas hover:text-text"
          onClick={() => setValue('')}
          type="button"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      ) : null}
    </label>
  );
}
