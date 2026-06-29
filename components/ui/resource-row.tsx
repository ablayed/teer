import { cn } from '@/lib/utils';
import Link from 'next/link';
import type * as React from 'react';

type ResourceRowProps = {
  href?: string;
  leading?: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  status?: React.ReactNode;
  primaryAction?: React.ReactNode;
  overflow?: React.ReactNode;
  className?: string;
};

export function ResourceRow({
  href,
  leading,
  title,
  meta,
  status,
  primaryAction,
  overflow,
  className,
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

  return (
    <div
      className={cn(
        '@container/row flex min-h-[56px] items-center gap-2 px-3 py-2',
        'border-b border-border last:border-b-0',
        className,
      )}
    >
      {href ? (
        <Link
          className="flex min-w-0 flex-1 items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-surface"
          href={href}
        >
          {mainContent}
        </Link>
      ) : (
        mainContent
      )}
      {status}
      {primaryAction}
      {overflow}
    </div>
  );
}
