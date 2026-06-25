import { cn } from '@/lib/utils';

export function Wordmark({
  size = 'md',
  className,
}: {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const sizes = {
    sm: 'text-lg',
    md: 'text-2xl',
    lg: 'text-5xl md:text-6xl',
  };
  return (
    <span
      className={cn(
        `font-display ${sizes[size]} tracking-tight inline-flex items-baseline`,
        className,
      )}
    >
      T<span className="text-[var(--color-accent)]">ë</span>
      <span className="text-[var(--color-accent)]">ë</span>r
    </span>
  );
}
