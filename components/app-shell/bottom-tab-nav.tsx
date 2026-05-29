'use client';

import { cn } from '@/lib/utils';
import { LayoutDashboard, type LucideIcon, Package, Settings, ShoppingBag } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

type BottomTabKey = 'tableau' | 'commandes' | 'produits' | 'parametres';

type BottomTabItem = {
  href: string;
  icon: LucideIcon;
  labelKey: BottomTabKey;
};

const bottomTabItems: BottomTabItem[] = [
  { href: '/tableau', icon: LayoutDashboard, labelKey: 'tableau' },
  { href: '/commandes', icon: ShoppingBag, labelKey: 'commandes' },
  { href: '/produits', icon: Package, labelKey: 'produits' },
  { href: '/parametres', icon: Settings, labelKey: 'parametres' },
];

function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function BottomTabNav() {
  const t = useTranslations('nav');
  const pathname = usePathname();

  return (
    <nav
      aria-label={t('ariaLabel')}
      className="fixed inset-x-0 bottom-0 z-40 flex h-[calc(64px+env(safe-area-inset-bottom))] border-border border-t bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {bottomTabItems.map((item) => {
        const Icon = item.icon;
        const active = isActivePath(pathname, item.href);

        return (
          <Link
            aria-current={active ? 'page' : undefined}
            aria-label={t(item.labelKey)}
            className={cn(
              'flex min-h-12 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium transition',
              active ? 'text-accent' : 'text-muted hover:text-text',
            )}
            href={item.href}
            key={item.href}
          >
            <Icon aria-hidden="true" className="size-[22px]" />
            <span>{t(item.labelKey)}</span>
          </Link>
        );
      })}
    </nav>
  );
}
