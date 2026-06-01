import { cn } from '@/lib/utils';
import { type VariantProps, cva } from 'class-variance-authority';
import type { ComponentProps } from 'react';

const cardVariants = cva('rounded-lg border border-border bg-surface shadow-1', {
  variants: {
    padding: {
      none: '',
      sm: 'p-4',
      md: 'p-5',
      lg: 'p-6',
    },
    tone: {
      default: '',
      success: 'bg-success-subtle',
      attention: 'ring-1 ring-accent/35',
      warning: 'bg-accent-subtle',
      danger: 'bg-danger-subtle',
    },
  },
  defaultVariants: {
    padding: 'md',
    tone: 'default',
  },
});

type CardProps = ComponentProps<'section'> & VariantProps<typeof cardVariants>;

export function Card({ className, padding, tone, ...props }: CardProps) {
  return <section className={cn(cardVariants({ padding, tone }), className)} {...props} />;
}
