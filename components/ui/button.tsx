import { cn } from '@/lib/utils';
import { type VariantProps, cva } from 'class-variance-authority';
import type { ComponentProps } from 'react';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-md font-medium transition active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      size: {
        default: 'h-11 px-5',
        sm: 'h-9 px-3 text-sm',
      },
      variant: {
        primary: 'bg-accent text-accent-ink hover:bg-accent-hover',
        ghost: 'bg-transparent text-text hover:bg-canvas',
        secondary: 'border border-border bg-surface text-text shadow-1 hover:bg-canvas',
        destructive: 'border border-danger/30 bg-danger-subtle text-danger hover:bg-danger/15',
      },
    },
    defaultVariants: {
      size: 'default',
      variant: 'primary',
    },
  },
);

type ButtonProps = ComponentProps<'button'> & VariantProps<typeof buttonVariants>;

export function Button({ className, size, type = 'button', variant, ...props }: ButtonProps) {
  return (
    <button className={cn(buttonVariants({ size, variant }), className)} type={type} {...props} />
  );
}
