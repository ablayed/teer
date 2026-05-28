import { cn } from '@/lib/utils';
import type { ComponentProps } from 'react';

type ButtonProps = ComponentProps<'button'> & {
  size?: 'default' | 'sm';
  variant?: 'primary' | 'ghost';
};

const sizes = {
  default: 'h-11 px-5',
  sm: 'h-9 px-3 text-sm',
};

const variants = {
  primary: 'bg-accent text-[#111] hover:bg-accent-soft',
  ghost: 'bg-transparent text-text hover:bg-canvas',
};

export function Button({
  className,
  size = 'default',
  type = 'button',
  variant = 'primary',
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition disabled:pointer-events-none disabled:opacity-50',
        sizes[size],
        variants[variant],
        className,
      )}
      type={type}
      {...props}
    />
  );
}
