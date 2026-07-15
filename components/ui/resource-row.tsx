'use client';

import { cn } from '@/lib/utils';
import Link from 'next/link';
import type * as React from 'react';

type ResourceRowBase = {
  leading?: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  status?: React.ReactNode;
  primaryAction?: React.ReactNode;
  overflow?: React.ReactNode;
  className?: string;
};

type ResourceRowWithHref = ResourceRowBase & {
  href: string;
  onActivate?: never;
  /**
   * Passe `false` pour désactiver le prefetch Next (défaut: comportement natif = true).
   * Utile quand le jeu de lignes/liens change à haute fréquence (ex. recherche instantanée
   * `/commandes`) : sans ça, chaque frappe monte de nouveaux `<Link>` qui déclenchent chacun
   * un prefetch RSC concurrent, souvent annulé avant résolution.
   */
  prefetch?: boolean;
};
type ResourceRowWithActivate = ResourceRowBase & {
  href?: never;
  onActivate?: () => void;
  prefetch?: never;
};

export type ResourceRowProps = ResourceRowWithHref | ResourceRowWithActivate;

export function ResourceRow({
  href,
  onActivate,
  leading,
  title,
  meta,
  status,
  primaryAction,
  overflow,
  className,
  prefetch,
}: ResourceRowProps) {
  const mainContent = (
    <span className="flex min-w-0 flex-1 items-center gap-3">
      {leading}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{title}</span>
        {meta ? (
          <span className="@max-[22rem]/row:hidden block truncate text-sm text-muted">{meta}</span>
        ) : null}
      </span>
    </span>
  );

  const linkClasses =
    'flex min-w-0 flex-1 items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-surface';

  return (
    <div
      className={cn(
        '@container/row flex min-h-[56px] items-center gap-2 px-3 py-2',
        'border-b border-border last:border-b-0',
        className,
      )}
    >
      {href ? (
        <Link className={linkClasses} href={href} prefetch={prefetch}>
          {mainContent}
        </Link>
      ) : onActivate ? (
        <button className={cn(linkClasses, 'text-left')} onClick={onActivate} type="button">
          {mainContent}
        </button>
      ) : (
        mainContent
      )}
      {status}
      {primaryAction}
      {overflow}
    </div>
  );
}
