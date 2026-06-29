'use client';

import { NavLinkPending } from '@/components/app-shell/nav-link-pending';
import { cn } from '@/lib/utils';
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
  Store,
  Truck,
  Users,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

type BottomTabKey =
  | 'tableau'
  | 'commandes'
  | 'clients'
  | 'produits'
  | 'livreurs'
  | 'analyses'
  | 'finances'
  | 'assistant'
  | 'boutiques'
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
  { href: '/boutiques', icon: Store, labelKey: 'boutiques' },
  { href: '/parametres', icon: Settings, labelKey: 'parametres' },
];

function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function isAllowed(item: BottomTabItem, currentRole?: string | null): boolean {
  return (
    (!item.ownerManagerOnly || currentRole === 'owner' || currentRole === 'manager') &&
    (!item.ownerOnly || currentRole === 'owner')
  );
}

export function BottomTabNav({ currentRole }: { currentRole?: string | null }) {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const visibleItems = primaryItems.filter((item) => isAllowed(item, currentRole)).slice(0, 4);
  const overflow = overflowItems
    .filter((item) => isAllowed(item, currentRole))
    .filter((item) => !visibleItems.some((visible) => visible.href === item.href));
  const overflowActive = overflow.some((item) => isActivePath(pathname, item.href));

  return (
    <>
      {open && overflow.length > 0 ? (
        <div className="fixed inset-x-3 bottom-[calc(72px+env(safe-area-inset-bottom))] z-50 rounded-lg border border-border bg-surface p-2 shadow-2 md:hidden">
          <div className="grid grid-cols-2 gap-2">
            {overflow.map((item) => {
              const Icon = item.icon;
              const active = isActivePath(pathname, item.href);

              return (
                <Link
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium transition',
                    active ? 'bg-canvas text-text' : 'text-muted hover:bg-canvas hover:text-text',
                  )}
                  href={item.href}
                  key={item.href}
                  onClick={() => setOpen(false)}
                  prefetch
                >
                  <Icon aria-hidden="true" className="size-5 shrink-0" />
                  <span className="min-w-0 truncate">{t(item.labelKey)}</span>
                </Link>
              );
            })}
          </div>
        </div>
      ) : null}

      <nav
        aria-label={t('ariaLabel')}
        className="fixed inset-x-0 bottom-0 z-40 flex h-[calc(64px+env(safe-area-inset-bottom))] border-border border-t bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {visibleItems.map((item) => {
          const Icon = item.icon;
          const active = isActivePath(pathname, item.href);

          return (
            <Link
              aria-current={active ? 'page' : undefined}
              aria-label={t(item.labelKey)}
              className={cn(
                'relative flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 px-1 text-[11px] font-medium transition',
                active ? 'text-accent' : 'text-muted hover:text-text',
              )}
              href={item.href}
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
            aria-expanded={open}
            aria-label="Plus"
            className={cn(
              'relative flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 px-1 text-[11px] font-medium transition',
              overflowActive || open ? 'text-accent' : 'text-muted hover:text-text',
            )}
            onClick={() => setOpen((value) => !value)}
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
