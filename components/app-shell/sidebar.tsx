'use client';

import { SignOutButton } from '@/components/sign-out-button';
import { Wordmark } from '@/components/wordmark';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  type LucideIcon,
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

type NavKey =
  | 'tableau'
  | 'commandes'
  | 'clients'
  | 'produits'
  | 'livreurs'
  | 'finances'
  | 'boutiques'
  | 'parametres';

type SidebarItem = {
  href: string;
  icon: LucideIcon;
  labelKey: NavKey;
  ownerManagerOnly?: boolean;
  ownerOnly?: boolean;
};

const sidebarItems: SidebarItem[] = [
  { href: '/tableau', icon: LayoutDashboard, labelKey: 'tableau' },
  { href: '/commandes', icon: ShoppingBag, labelKey: 'commandes' },
  { href: '/clients', icon: Users, labelKey: 'clients' },
  { href: '/produits', icon: Package, labelKey: 'produits' },
  { href: '/livreurs', icon: Truck, labelKey: 'livreurs', ownerManagerOnly: true },
  { href: '/finances', icon: ReceiptText, labelKey: 'finances', ownerOnly: true },
  { href: '/boutiques', icon: Store, labelKey: 'boutiques' },
  { href: '/parametres', icon: Settings, labelKey: 'parametres' },
];

function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar({ currentRole }: { currentRole?: string | null }) {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const items = sidebarItems.filter(
    (item) =>
      (!item.ownerManagerOnly || currentRole === 'owner' || currentRole === 'manager') &&
      (!item.ownerOnly || currentRole === 'owner'),
  );

  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-[280px] flex-col border-border border-r bg-surface md:flex">
      <div className="px-6 py-6">
        <Wordmark size="md" />
      </div>

      <nav aria-label={t('ariaLabel')} className="px-3">
        <ul className="space-y-1">
          {items.map((item) => {
            const Icon = item.icon;
            const active = isActivePath(pathname, item.href);

            return (
              <li key={item.href}>
                <Link
                  aria-current={active ? 'page' : undefined}
                  aria-label={t(item.labelKey)}
                  className={cn(
                    'relative flex h-11 items-center gap-3 rounded-md px-4 text-[15px] font-medium transition',
                    active ? 'bg-canvas text-text' : 'text-muted hover:bg-canvas hover:text-text',
                  )}
                  href={item.href}
                >
                  {active ? (
                    <span className="absolute left-0 h-7 w-[3px] rounded-r bg-accent" />
                  ) : null}
                  <Icon aria-hidden="true" className="size-5 shrink-0" />
                  <span>{t(item.labelKey)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="mt-auto border-border border-t p-3">
        <SignOutButton className="h-11 w-full justify-start text-muted hover:text-text" />
      </div>
    </aside>
  );
}
