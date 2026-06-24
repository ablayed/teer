'use client';

import { Search, X } from 'lucide-react';

type OrdersSearchInputProps = {
  onValueChange: (value: string) => void;
  value: string;
};

export function OrdersSearchInput({ onValueChange, value }: OrdersSearchInputProps) {
  return (
    <label className="relative block">
      <span className="sr-only">Rechercher une commande</span>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
      />
      <input
        className="min-h-11 w-full rounded-lg border border-border bg-surface pr-12 pl-9 text-sm text-text outline-none focus:border-accent"
        onChange={(event) => onValueChange(event.target.value)}
        placeholder="Nom, telephone ou produit"
        type="search"
        value={value}
      />
      {value ? (
        <button
          aria-label="Effacer la recherche"
          className="absolute top-1/2 right-1 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded-lg text-muted hover:bg-canvas hover:text-text"
          onClick={() => onValueChange('')}
          type="button"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      ) : null}
    </label>
  );
}
