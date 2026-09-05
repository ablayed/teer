import { cn } from '@/lib/utils';
import type { ComponentProps } from 'react';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-12 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text shadow-1 transition placeholder:text-muted focus:border-accent',
        className,
      )}
      {...props}
    />
  );
}
