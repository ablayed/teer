import { cn } from '@/lib/utils';
import { type VariantProps, cva } from 'class-variance-authority';
import type { ComponentProps } from 'react';

const badgeVariants = cva(
  'inline-flex h-7 items-center gap-1.5 rounded-sm border px-2.5 text-xs font-semibold',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-canvas text-muted',
        attention: 'border-accent/35 bg-accent-subtle text-text',
        primary: 'border-accent/35 bg-accent text-accent-ink',
        success: 'border-success/25 bg-success-subtle text-success',
        danger: 'border-danger/25 bg-danger-subtle text-danger',
      },
    },
    defaultVariants: {
      tone: 'neutral',
    },
  },
);

type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants>;

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
