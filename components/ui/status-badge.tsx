import { cn } from '@/lib/utils';

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const TONE_CLASS: Record<StatusTone, string> = {
  neutral: 'bg-muted/15 text-text',
  info: 'bg-info/15 text-info',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning-foreground',
  danger: 'bg-danger/15 text-danger',
};

type StatusBadgeProps = {
  tone?: StatusTone;
  label: string;
  className?: string;
};

export function StatusBadge({ tone, label, className }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium',
        tone ? TONE_CLASS[tone] : undefined,
        className,
      )}
    >
      {label}
    </span>
  );
}
