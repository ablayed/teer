'use client';

import { NavLinkPending } from '@/components/app-shell/nav-link-pending';
import { StoreSwitcher } from '@/components/workspace/store-switcher';
import { cn } from '@/lib/utils';
import type { WorkspaceStore } from '@/lib/workspace/store';
import {
  ChartColumnIncreasing,
  HelpCircle,
  LayoutDashboard,
  type LucideIcon,
  MoreHorizontal,
  Package,
  ReceiptText,
  Settings,
  ShoppingBag,
  Truck,
  Users,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

type BottomTabKey =
  | 'tableau'
  | 'commandes'
  | 'clients'
  | 'produits'
  | 'livreurs'
  | 'analyses'
  | 'finances'
  | 'assistant'
  | 'parametres';

type BottomTabItem = {
  href: string;
  icon: LucideIcon;
  labelKey: BottomTabKey;
  ownerManagerOnly?: boolean;
  ownerOnly?: boolean;
};

const primaryItems: BottomTabItem[] = [
  { href: '/tableau', icon: LayoutDashboard, labelKey: 'tableau' },
  { href: '/commandes', icon: ShoppingBag, labelKey: 'commandes' },
  { href: '/clients', icon: Users, labelKey: 'clients' },
  { href: '/produits', icon: Package, labelKey: 'produits' },
];

const overflowItems: BottomTabItem[] = [
  { href: '/livreurs', icon: Truck, labelKey: 'livreurs', ownerManagerOnly: true },
  { href: '/assistant', icon: HelpCircle, labelKey: 'assistant' },
  {
    href: '/analyses',
    icon: ChartColumnIncreasing,
    labelKey: 'analyses',
    ownerManagerOnly: true,
  },
  { href: '/finances', icon: ReceiptText, labelKey: 'finances', ownerOnly: true },
  { href: '/parametres', icon: Settings, labelKey: 'parametres' },
];

// Réglages épinglés en bas du menu « Plus » : seul séparateur de groupe, posé
// AVANT ces entrées. Préserve l'ordre source (Paramètres est déjà en dernier).
const settingsHrefs = new Set<string>(['/parametres']);

function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function isAllowed(item: BottomTabItem, currentRole?: string | null): boolean {
  return (
    (!item.ownerManagerOnly || currentRole === 'owner' || currentRole === 'manager') &&
    (!item.ownerOnly || currentRole === 'owner')
  );
}

export function BottomTabNav({
  currentRole,
  currentStore,
  stores = [],
}: {
  currentRole?: string | null;
  currentStore?: WorkspaceStore;
  stores?: WorkspaceStore[];
}) {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const visibleItems = primaryItems.filter((item) => isAllowed(item, currentRole)).slice(0, 4);
  const overflow = overflowItems
    .filter((item) => isAllowed(item, currentRole))
    .filter((item) => !visibleItems.some((visible) => visible.href === item.href));
  const overflowActive = overflow.some((item) => isActivePath(pathname, item.href));
  const overflowMain = overflow.filter((item) => !settingsHrefs.has(item.href));
  const overflowSettings = overflow.filter((item) => settingsHrefs.has(item.href));
  const storePath = (href: string) => (currentStore ? `/s/${currentStore.id}${href}` : href);

  // Fermeture du menu « Plus » : Échap (focus rendu au bouton) + clic extérieur.
  // On exclut explicitement le bouton déclencheur : sinon `pointerdown` ferme,
  // puis son `onClick` rouvre → battement. Le clic SUR un lien interne navigue
  // (onClick du Link traité avant la fermeture déclenchée par ce listener).
  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node | null;

      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) {
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

  function renderOverflowLink(item: BottomTabItem) {
    const Icon = item.icon;
    const href = storePath(item.href);
    const active = isActivePath(pathname, href);

    return (
      <Link
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex min-h-11 items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          active ? 'bg-accent-subtle text-accent-deep' : 'text-text hover:bg-canvas',
        )}
        href={href}
        key={item.href}
        onClick={() => setOpen(false)}
        prefetch
      >
        <Icon aria-hidden="true" className="size-5 shrink-0" />
        <span className="min-w-0 truncate">{t(item.labelKey)}</span>
      </Link>
    );
  }

  return (
    <>
      {open && overflow.length > 0 ? (
        <div
          className="mobile-more-menu-enter fixed inset-x-3 bottom-[calc(var(--mobile-nav-reserved-height)_+_8px)] z-50 rounded-[22px] border border-border bg-surface p-2 shadow-warm-3 md:hidden"
          id="mobile-more-menu"
          ref={panelRef}
        >
          <div className="flex flex-col gap-1">
            {/* Contexte de boutique mobile : dans le menu de navigation, donc
                atteignable partout sans consommer de hauteur de contenu permanente
                (l'ancienne barre pleine largeur en occupait sur chaque page). */}
            {currentStore ? (
              <>
                <StoreSwitcher currentStore={currentStore} stores={stores} variant="menu" />
                <div aria-hidden="true" className="my-1 h-px bg-border" />
              </>
            ) : null}
            {overflowMain.map(renderOverflowLink)}
            {overflowMain.length > 0 && overflowSettings.length > 0 ? (
              <div aria-hidden="true" className="my-1 h-px bg-border" />
            ) : null}
            {overflowSettings.map(renderOverflowLink)}
          </div>
        </div>
      ) : null}

      <nav
        aria-label={t('ariaLabel')}
        className="fixed inset-x-3 bottom-[calc(var(--bottom-nav-gap)_+_env(safe-area-inset-bottom))] z-40 flex h-[var(--bottom-nav-height)] items-stretch gap-1 rounded-[22px] border border-border bg-surface p-1.5 shadow-warm-2 md:hidden"
      >
        {visibleItems.map((item) => {
          const Icon = item.icon;
          const href = storePath(item.href);
          const active = isActivePath(pathname, href);

          return (
            <Link
              aria-current={active ? 'page' : undefined}
              aria-label={t(item.labelKey)}
              className={cn(
                'relative flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-2xl px-1 text-[11px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                active ? 'bg-accent-subtle text-accent-deep' : 'text-muted hover:text-text',
              )}
              href={href}
              key={item.href}
              onClick={() => setOpen(false)}
              prefetch
            >
              <NavLinkPending className="absolute top-1 right-1.5" />
              <Icon aria-hidden="true" className="size-[22px] shrink-0" />
              <span className="max-w-full truncate">{t(item.labelKey)}</span>
            </Link>
          );
        })}

        {overflow.length > 0 ? (
          <button
            aria-controls="mobile-more-menu"
            aria-expanded={open}
            aria-label="Plus"
            className={cn(
              'relative flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-2xl px-1 text-[11px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              overflowActive || open
                ? 'bg-accent-subtle text-accent-deep'
                : 'text-muted hover:text-text',
            )}
            onClick={() => setOpen((value) => !value)}
            ref={buttonRef}
            type="button"
          >
            <MoreHorizontal aria-hidden="true" className="size-[22px] shrink-0" />
            <span className="max-w-full truncate">Plus</span>
          </button>
        ) : null}
      </nav>
    </>
  );
}
