import { cn } from '@/lib/utils';
import type * as React from 'react';

type EmptyStateProps = {
  title: string;
  description?: string;
  illustration?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
};

export function EmptyState({
  title,
  description,
  illustration,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border bg-canvas px-6 py-12 text-center',
        className,
      )}
    >
      {illustration ? (
        <div aria-hidden="true" className="text-muted">
          {illustration}
        </div>
      ) : null}
      <div className="max-w-xs">
        <p className="font-semibold text-text">{title}</p>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      </div>
      {action ? <div>{action}</div> : null}
    </div>
  );
}
