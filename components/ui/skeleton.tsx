import { cn } from '@/lib/utils';

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('dashboard-shimmer rounded-md', className)} />;
}

export function ResourceRowSkeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'flex min-h-[56px] items-center gap-3 border-b border-border px-3 py-2 last:border-b-0',
        className,
      )}
    >
      <div className="dashboard-shimmer size-9 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="dashboard-shimmer h-3.5 w-2/3 rounded" />
        <div className="dashboard-shimmer h-3 w-1/2 rounded" />
      </div>
      <div className="dashboard-shimmer h-6 w-16 shrink-0 rounded-md" />
    </div>
  );
}

export function StatCardSkeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn('space-y-2 rounded-lg border border-border bg-surface p-4', className)}
    >
      <div className="dashboard-shimmer h-3.5 w-1/2 rounded" />
      <div className="dashboard-shimmer h-8 w-3/4 rounded" />
      <div className="dashboard-shimmer h-3 w-1/3 rounded" />
    </div>
  );
}
