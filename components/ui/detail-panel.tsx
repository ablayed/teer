'use client';

import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from '@/components/ui/drawer';
import { useIsDesktop } from '@/hooks/use-is-desktop';
import { cn } from '@/lib/utils';
import { X } from 'lucide-react';
import * as React from 'react';

type DetailPanelProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  closeLabel: string;
  children: React.ReactNode;
  className?: string;
};

export function DetailPanel({
  open,
  onClose,
  title,
  closeLabel,
  children,
  className,
}: DetailPanelProps) {
  const isDesktop = useIsDesktop();
  const closeButtonRef = React.useRef<HTMLButtonElement>(null);

  // Élément à refocaliser à la fermeture. Deux façons d'utiliser ce composant coexistent
  // dans le projet : `open` qui bascule sur un composant qui reste monté (ExplanationCard),
  // et `open` figé à `true` sur un composant monté/démonté par le parent (ProductDetailPanel).
  // L'initialiseur de useRef couvre le 2ᵉ cas (capturé au tout premier rendu, avant que
  // quoi que ce soit à l'intérieur du panneau ne vole le focus) ; le bloc synchrone ci-dessous
  // couvre le 1ᵉʳ cas (capturé pendant le rendu, PAS dans un effet — un effet enfant comme
  // celui de vaul se déclenche avant un effet parent, il aurait déjà déplacé le focus).
  const previouslyFocusedRef = React.useRef<HTMLElement | null>(
    typeof document !== 'undefined' ? (document.activeElement as HTMLElement) : null,
  );
  const wasOpenRef = React.useRef(open);
  if (open && !wasOpenRef.current && typeof document !== 'undefined') {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
  }
  wasOpenRef.current = open;

  React.useEffect(() => {
    if (!open) return;
    // rAF : sur mobile, vaul monte le contenu du tiroir fermé/hors-écran puis l'anime au
    // frame suivant (data-state → open) — un .focus() synchrone dans ce même commit cible un
    // élément pas encore focusable (transform/visibility pas encore appliqués), silencieusement
    // ignoré par le navigateur. Un rAF laisse ce frame se produire avant de focaliser.
    const raf = requestAnimationFrame(() => {
      closeButtonRef.current?.focus();
    });
    // Le cleanup couvre aussi bien open→false (bascule) que le démontage complet du
    // composant (pattern ProductDetailPanel) — dans les deux cas le focus doit revenir.
    return () => {
      cancelAnimationFrame(raf);
      previouslyFocusedRef.current?.focus();
    };
  }, [open]);

  React.useEffect(() => {
    if (!isDesktop || !open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isDesktop, open, onClose]);

  if (isDesktop) {
    return (
      <>
        {/* Scrim — décoratif uniquement (aria-hidden). La fermeture clavier passe par
            le useEffect Escape ci-dessus, pas par cet élément. */}
        <div
          aria-hidden="true"
          className={cn(
            'fixed inset-0 z-40 bg-black/40 transition-opacity duration-[250ms]',
            open ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
          role="presentation"
          onClick={onClose}
          onKeyDown={undefined}
        />
        {/* Panneau — toujours dans le DOM (open={true}) pour l'animation CSS de sortie.
            aria-hidden quand fermé pour masquer des AT.
            `left-auto` : la feuille de style par défaut du navigateur pour <dialog> pose
            `inset: 0` (donc `left: 0`), qu'aucune classe ci-dessous ne réinitialise sinon.
            Avec `right-0` + une largeur explicite, la boîte devient sur-contrainte et le
            navigateur (LTR) ignore alors `right` au profit de ce `left: 0` hérité — le panneau
            se retrouve ancré à GAUCHE au lieu de la droite, et `translate-x-full` (pensé pour
            sortir par la droite) le fait juste glisser d'une position visible à une autre :
            il ne quitte jamais l'écran, quel que soit l'état ouvert/fermé. Bug réel, pas
            hypothétique — reproduit en Chromium réel (Playwright), invisible en JSDOM. */}
        <dialog
          aria-hidden={!open}
          aria-label={title}
          className={cn(
            'fixed top-0 right-0 left-auto z-50 m-0 flex h-dvh max-h-dvh min-h-0 w-full max-w-[480px] flex-col overflow-hidden border-0 bg-surface p-0 shadow-2 outline-none',
            'translate-x-full transition-transform duration-[250ms] ease-[cubic-bezier(0.22,1,0.36,1)]',
            open && 'translate-x-0',
            className,
          )}
          open
        >
          <header className="flex min-h-[56px] shrink-0 items-center justify-between border-b border-border px-4">
            <span className="text-base font-semibold text-text">{title}</span>
            <button
              aria-label={closeLabel}
              className="inline-flex size-11 items-center justify-center rounded-md text-muted hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={onClose}
              ref={closeButtonRef}
              type="button"
            >
              <X aria-hidden="true" className="size-5" />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </dialog>
      </>
    );
  }

  return (
    <Drawer
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DrawerContent className={cn('bg-surface pb-[env(safe-area-inset-bottom)]', className)}>
        <div className="flex items-center justify-between px-4 py-3">
          <DrawerTitle className="text-base font-semibold">{title}</DrawerTitle>
          <DrawerClose asChild>
            <button
              aria-label={closeLabel}
              className="inline-flex size-11 items-center justify-center rounded-md text-muted"
              ref={closeButtonRef}
              type="button"
            >
              <X aria-hidden="true" className="size-5" />
            </button>
          </DrawerClose>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">{children}</div>
      </DrawerContent>
    </Drawer>
  );
}
