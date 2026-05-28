export function Wordmark({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const sizes = {
    sm: 'text-lg',
    md: 'text-2xl',
    lg: 'text-5xl md:text-6xl',
  };
  return (
    <span className={`font-display ${sizes[size]} tracking-tight inline-flex items-baseline`}>
      T<span className="text-[var(--color-accent)]">ë</span>
      <span className="text-[var(--color-accent)]">ë</span>r
    </span>
  );
}
