'use client';

import { normalizeOrderSearch } from '@/lib/orders/search';
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
      // Guard idempotent : on compare les recherches NORMALISÉES (trim + lowercase, comme
      // le matching serveur). Si la recherche de l'URL est déjà équivalente à la saisie,
      // on NE fait AUCUN router.replace — sinon un replace purement cosmétique (re-casse
      // « Client » → « client ») partirait 180 ms après montage et annulerait la soft-nav
      // d'un <Link> cliqué dans cette fenêtre (le détail ne s'ouvrirait pas — pire sur
      // connexion lente). Le replace ne part donc QUE sur un vrai changement de recherche.
      const currentValue = normalizeOrderSearch(nextParams.get('q'));
      const normalizedValue = normalizeOrderSearch(value);

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
