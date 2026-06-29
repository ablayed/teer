import { cn } from '@/lib/utils';
import type * as React from 'react';

type StatCardProps = {
  label: string;
  value: React.ReactNode;
  delta?: React.ReactNode;
  className?: string;
};

export function StatCard({ label, value, delta, className }: StatCardProps) {
  return (
    <div
      className={cn(
        '@container/stat rounded-lg border border-border bg-surface p-3 @min-[10rem]/stat:p-4',
        className,
      )}
    >
      <p className="text-xs font-medium text-muted @min-[10rem]/stat:text-sm">{label}</p>
      <p className="mt-1 truncate text-2xl font-semibold text-text @min-[10rem]/stat:text-3xl">
        {value}
      </p>
      {delta ? (
        <div className="@max-[10rem]/stat:hidden mt-1 text-xs text-muted">{delta}</div>
      ) : null}
    </div>
  );
}
