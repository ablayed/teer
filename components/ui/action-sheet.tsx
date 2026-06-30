'use client';

import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer';
import { useIsDesktop } from '@/hooks/use-is-desktop';
import { cn } from '@/lib/utils';
import * as React from 'react';

export type ActionSheetItem = {
  key: string;
  label: string;
  icon?: React.ReactNode;
  onSelect: () => void;
  variant?: 'default' | 'destructive';
  disabled?: boolean;
};

type ActionSheetProps = {
  trigger: React.ReactNode;
  items: ActionSheetItem[];
  /** Titre du bottom-sheet mobile, déjà traduit par l'appelant. */
  title: string;
  align?: 'start' | 'end';
};

export function ActionSheet({ trigger, items, title, align = 'end' }: ActionSheetProps) {
  const isDesktop = useIsDesktop();
  const [open, setOpen] = React.useState(false);

  // ── Desktop ──────────────────────────────────────────────────────────────

  const containerRef = React.useRef<HTMLDivElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = React.useState<'down' | 'up'>('down');
  const [maxHeight, setMaxHeight] = React.useState<number | null>(null);

  // Injection du toggle + aria sur le trigger desktop (merge le onClick existant).
  const desktopTrigger = React.isValidElement(trigger)
    ? React.cloneElement(
        trigger as React.ReactElement<{
          onClick?: React.MouseEventHandler;
          'aria-haspopup'?: 'menu';
          'aria-expanded'?: boolean;
        }>,
        {
          onClick: (e: React.MouseEvent) => {
            const existing = (trigger as React.ReactElement<{ onClick?: React.MouseEventHandler }>)
              .props.onClick;
            existing?.(e);
            setOpen((v) => !v);
          },
          'aria-haspopup': 'menu' as const,
          'aria-expanded': open,
        },
      )
    : trigger;

  // Placement up/down + maxHeight — porté fidèlement depuis OrderActionsMenu.
  React.useLayoutEffect(() => {
    if (!isDesktop || !open) return;

    function reposition() {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const gap = 8;
      const bottomInset = window.innerWidth < 768 ? 96 : 8;
      const spaceBelow = window.innerHeight - bottomInset - rect.bottom - gap;
      const spaceAbove = rect.top - gap;
      const next: 'down' | 'up' = spaceBelow < 240 && spaceAbove > spaceBelow ? 'up' : 'down';
      setPlacement(next);
      setMaxHeight(Math.max(160, Math.floor(next === 'up' ? spaceAbove : spaceBelow)));
    }

    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, isDesktop]);

  // Click-outside + Escape — focus retourné au trigger sur Escape.
  React.useEffect(() => {
    if (!isDesktop || !open) return;

    function onPointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        // Premier bouton dans le container = le trigger (les menuitems viennent après).
        containerRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
      }
    }

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, isDesktop]);

  // Focus sur le premier item à l'ouverture.
  React.useEffect(() => {
    if (!isDesktop || !open) return;
    const id = requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
        ?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [open, isDesktop]);

  if (isDesktop) {
    return (
      <div className="relative" ref={containerRef}>
        {desktopTrigger}
        {open ? (
          <div
            ref={menuRef}
            className={cn(
              'absolute z-50 w-60 overflow-y-auto overscroll-contain rounded-lg border border-border bg-surface py-1 shadow-2',
              align === 'end' ? 'right-0' : 'left-0',
              placement === 'up' ? 'bottom-full mb-2' : 'top-full mt-2',
            )}
            role="menu"
            style={maxHeight ? { maxHeight } : undefined}
          >
            {items.map((item) => (
              <button
                key={item.key}
                className={cn(
                  'flex min-h-11 w-full items-center gap-2 px-4 text-left text-sm font-medium outline-none hover:bg-canvas focus-visible:bg-canvas',
                  item.variant === 'destructive' ? 'text-danger' : 'text-text',
                )}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                role="menuitem"
                type="button"
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  // ── Mobile (Vaul Drawer — portalisé sur <body>, jamais rogné par un parent) ──

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>{trigger}</DrawerTrigger>
      <DrawerContent className="bg-surface pb-[env(safe-area-inset-bottom)]">
        <DrawerHeader>
          <DrawerTitle>{title}</DrawerTitle>
        </DrawerHeader>
        <div className="flex flex-col gap-1 px-2 pb-4" role="menu">
          {items.map((item) => (
            <button
              key={item.key}
              className={cn(
                'flex min-h-[48px] w-full items-center gap-3 rounded-md px-4 text-left text-base font-medium',
                'transition-colors active:bg-accent disabled:opacity-50',
                item.variant === 'destructive' ? 'text-danger' : 'text-text',
              )}
              data-testid={`action-sheet-item-${item.key}`}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              role="menuitem"
              type="button"
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
