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
            aria-hidden quand fermé pour masquer des AT. */}
        <dialog
          aria-hidden={!open}
          aria-label={title}
          className={cn(
            'fixed top-0 right-0 z-50 m-0 flex h-dvh max-h-dvh min-h-0 w-full max-w-[480px] flex-col overflow-hidden border-0 bg-surface p-0 shadow-2 outline-none',
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
