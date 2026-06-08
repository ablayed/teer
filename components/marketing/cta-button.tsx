import { cn } from '@/lib/utils';
import Link from 'next/link';
import type { ReactNode } from 'react';

// CTA marketing. Server component, hover en CSS pur (n'alourdit pas l'INP).
// Règle de marque : texte sur orange = #111, jamais blanc. Cible tap ≥ 44px.
type CtaButtonProps = {
  href: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary';
  className?: string;
};

export function CtaButton({ href, children, variant = 'primary', className }: CtaButtonProps) {
  return (
    <Link
      href={href}
      className={cn(
        'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full px-7 py-3 text-[15px] font-medium transition duration-200 ease-out',
        variant === 'primary'
          ? 'bg-accent text-[#111] shadow-warm-2 hover:-translate-y-0.5 hover:bg-accent-hover hover:shadow-warm-3'
          : 'border border-border bg-surface/70 text-text hover:-translate-y-0.5 hover:border-accent/40 hover:text-accent-deep',
        className,
      )}
    >
      {children}
    </Link>
  );
}
