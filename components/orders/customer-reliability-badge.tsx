import { cn } from '@/lib/utils';

type ReliabilityTier = 'new' | 'reliable' | 'risk' | 'watch';

type CustomerReliabilityBadgeProps = {
  labels: Record<ReliabilityTier, string>;
  tier: ReliabilityTier | null;
};

const classes: Record<ReliabilityTier, string> = {
  new: 'border border-border bg-canvas text-muted',
  reliable: 'bg-success text-white',
  risk: 'bg-danger text-white',
  watch: 'bg-accent text-text',
};

export function CustomerReliabilityBadge({ labels, tier }: CustomerReliabilityBadgeProps) {
  if (!tier) {
    return null;
  }

  return (
    <span
      className={cn(
        'inline-flex max-w-[9rem] shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold leading-5',
        classes[tier],
      )}
    >
      {labels[tier]}
    </span>
  );
}
