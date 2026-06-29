import { cn } from '@/lib/utils';
import type * as React from 'react';

type PageHeaderProps = {
  title: string;
  subtitle?: string;
  search?: React.ReactNode;
  action?: React.ReactNode;
  overflow?: React.ReactNode;
  className?: string;
};

export function PageHeader({
  title,
  subtitle,
  search,
  action,
  overflow,
  className,
}: PageHeaderProps) {
  return (
    <header className={cn('flex flex-col gap-3 pb-4', className)}>
      <div className="flex min-h-[44px] items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold text-text">{title}</h1>
          {subtitle ? <p className="mt-0.5 truncate text-sm text-muted">{subtitle}</p> : null}
        </div>
        {action || overflow ? (
          <div className="flex shrink-0 items-center gap-2">
            {action}
            {overflow}
          </div>
        ) : null}
      </div>
      {search ? <div className="w-full">{search}</div> : null}
    </header>
  );
}
