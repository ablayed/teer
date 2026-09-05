'use client';

import { cn } from '@/lib/utils';
import { Search, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useTransition } from 'react';

const DEFAULT_DEBOUNCE_MS = 280;

type SearchInputProps = {
  /** Valeur contrôlée : l'appelant garde la main pour le filtrage instantané en mémoire. */
  value: string;
  /** Appelé à chaque frappe, immédiatement (couche de réactivité instantanée). */
  onValueChange: (value: string) => void;
  /** Appelé après le debounce avec la valeur nettoyée (déclenche un refetch éventuel). */
  onDebouncedChange?: (value: string) => void;
  /** Placeholder déjà traduit par l'appelant (next-intl). */
  placeholder: string;
  /** aria-label déjà traduit. */
  ariaLabel: string;
  /** Libellé du bouton d'effacement, déjà traduit. */
  clearLabel: string;
  /** Nom du paramètre d'URL synchronisé en shallow (défaut « q »). */
  paramName?: string;
  /** Synchronise l'URL via history.replaceState, sans navigation (défaut true). */
  syncUrl?: boolean;
  debounceMs?: number;
  className?: string;
};

/**
 * Primitive de recherche réutilisable (listes Phase 2).
 *
 * Anti scroll-jump : la synchro d'URL passe par `window.history.replaceState`
 * (shallow), donc AUCUNE navigation App Router — le scroll n'est pas réinitialisé
 * et le `loading.tsx` de la route n'est pas déclenché (contrairement à
 * `router.replace`, dont le `scroll:false` est ignoré dès qu'un `loading.tsx`
 * existe — cf. Next #84423). `useSearchParams` reste synchro pour les
 * consommateurs client. Le refetch serveur éventuel est branché par l'appelant
 * via `onDebouncedChange` (paradigme A : relecture serveur injectée dans le state).
 */
export function SearchInput({
  value,
  onValueChange,
  onDebouncedChange,
  placeholder,
  ariaLabel,
  clearLabel,
  paramName = 'q',
  syncUrl = true,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  className,
}: SearchInputProps) {
  const [, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Garde la dernière callback sans relancer le debounce à chaque rendu.
  const onDebouncedRef = useRef(onDebouncedChange);

  useEffect(() => {
    onDebouncedRef.current = onDebouncedChange;
  }, [onDebouncedChange]);

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  const commit = useCallback(
    (next: string) => {
      const trimmed = next.trim();

      if (syncUrl) {
        const params = new URLSearchParams(window.location.search);
        if (trimmed) {
          params.set(paramName, trimmed);
        } else {
          params.delete(paramName);
        }
        const queryString = params.toString();
        const nextUrl = queryString
          ? `${window.location.pathname}?${queryString}`
          : window.location.pathname;
        startTransition(() => {
          window.history.replaceState(null, '', nextUrl);
        });
      }

      onDebouncedRef.current?.(trimmed);
    },
    [paramName, syncUrl],
  );

  const handleChange = useCallback(
    (next: string) => {
      onValueChange(next);
      if (timer.current) {
        clearTimeout(timer.current);
      }
      timer.current = setTimeout(() => commit(next), debounceMs);
    },
    [commit, debounceMs, onValueChange],
  );

  return (
    <label className={cn('relative block', className)}>
      <span className="sr-only">{ariaLabel}</span>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
      />
      <input
        aria-label={ariaLabel}
        // text-base (≥16px) : empêche le zoom auto au focus sur iOS. min-h-12 = 48px.
        className="min-h-12 w-full rounded-lg border border-border bg-surface pr-12 pl-9 text-base text-text outline-none focus:border-accent"
        inputMode="search"
        onChange={(event) => handleChange(event.target.value)}
        placeholder={placeholder}
        type="search"
        value={value}
      />
      {value ? (
        <button
          aria-label={clearLabel}
          className="absolute top-1/2 right-1 inline-flex size-12 -translate-y-1/2 items-center justify-center rounded-lg text-muted hover:bg-canvas hover:text-text"
          onClick={() => handleChange('')}
          type="button"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      ) : null}
    </label>
  );
}
