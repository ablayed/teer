'use client';

import { cn } from '@/lib/utils';

type PendingSpinnerProps = {
  className?: string;
};

export function PendingSpinner({ className }: PendingSpinnerProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'pointer-events-none inline-block size-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none',
        className,
      )}
    />
  );
}
