'use client';

import { cn } from '@/lib/utils';
import type { WorkspaceStore } from '@/lib/workspace/store';
import { buildStoreSwitchHref } from '@/lib/workspace/store-switch';
import { Check, ChevronDown, Store } from 'lucide-react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';

/**
 * Contexte de boutique, rendu DANS la navigation (barre latérale desktop, menu
 * « Plus » mobile) plutôt qu'en tête du contenu.
 *
 * Il remplace `StoreContextBar`, une barre pleine largeur qui consommait de la
 * hauteur de contenu sur chaque page et dont le lien « Changer » renvoyait en dur
 * vers `/tableau`, faisant perdre la section courante.
 *
 * Mono-boutique : le nom reste affiché, mais aucun contrôle « Changer » n'est
 * rendu — laisser un bouton inerte suggérerait une action indisponible.
 */
export function StoreSwitcher({
  currentStore,
  stores,
  variant = 'sidebar',
}: {
  currentStore: WorkspaceStore;
  stores: WorkspaceStore[];
  variant?: 'sidebar' | 'menu';
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const canSwitch = stores.length > 1;

  // Fermeture au clic extérieur et à Échap, focus rendu au déclencheur. Le bouton
  // est exclu du clic extérieur : sinon `pointerdown` ferme puis `onClick` rouvre.
  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (containerRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const search = searchParams?.toString() ?? '';

  return (
    <div
      className={cn('relative', variant === 'sidebar' ? 'mx-3 mb-2' : 'mb-1')}
      data-testid="store-switcher"
      ref={containerRef}
    >
      <div className="flex min-h-11 items-center gap-2 rounded-md bg-canvas px-3 py-2">
        <Store aria-hidden="true" className="size-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <span className="block text-[11px] font-medium uppercase tracking-wide text-muted">
            Boutique
          </span>
          {/* `title` porte le nom complet pour la souris ; le contenu textuel reste
              intact pour les lecteurs d'écran même quand l'ellipse CSS le tronque. */}
          <span
            className="block truncate text-sm font-semibold text-text"
            data-testid="store-switcher-name"
            title={currentStore.displayName}
          >
            {currentStore.displayName}
          </span>
        </div>
        {canSwitch ? (
          <button
            aria-controls={menuId}
            aria-expanded={open}
            aria-haspopup="menu"
            className="shrink-0 rounded-md px-2 py-1 text-sm font-medium text-accent transition hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setOpen((value) => !value)}
            ref={buttonRef}
            type="button"
          >
            <span className="flex items-center gap-1">
              Changer
              <ChevronDown
                aria-hidden="true"
                className={cn('size-4 transition-transform', open && 'rotate-180')}
              />
            </span>
          </button>
        ) : null}
      </div>

      {open && canSwitch ? (
        // Hauteur bornée en `rem`, jamais en fraction de viewport : un
        // `max-h-[Xvh]` qui ne mord pas laisse `overflow-y-auto` sans rien à faire
        // défiler pendant que le bas du menu sort de la fenêtre (piège documenté
        // sur le PeriodPicker). Le parc de boutiques se compte en unités, donc une
        // borne fixe suffit et reste toujours atteignable.
        <div
          className="absolute inset-x-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-warm-3"
          id={menuId}
          role="menu"
        >
          {stores.map((store) => {
            const active = store.id === currentStore.id;
            return (
              // Ancre BRUTE, jamais `<Link>` : le middleware réécrit
              // `/s/{id}/produits` vers `/produits`, donc les deux boutiques
              // partagent les mêmes segments de route et le Router Cache client
              // peut resservir le rendu de la boutique PRÉCÉDENTE lors d'une
              // navigation RSC. Mesuré en build de production : après bascule, la
              // page restait sur les produits de l'ancienne boutique (échec
              // reproduit à l'identique au retry, donc pas un flake). Une
              // navigation document complète force le serveur à re-résoudre le
              // contexte de boutique. C'est aussi ce que faisait l'ancienne barre.
              <a
                aria-current={active ? 'true' : undefined}
                className={cn(
                  'flex min-h-12 items-center gap-2 rounded-md px-3 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active ? 'bg-accent-subtle text-accent-deep' : 'text-text hover:bg-canvas',
                )}
                href={buildStoreSwitchHref(pathname ?? '', store.id, search)}
                key={store.id}
                onClick={() => setOpen(false)}
                role="menuitem"
              >
                <Check
                  aria-hidden="true"
                  className={cn('size-4 shrink-0', active ? 'opacity-100' : 'opacity-0')}
                />
                <span className="min-w-0 truncate" title={store.displayName}>
                  {store.displayName}
                </span>
              </a>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
