import { Amount } from '@/components/ui/amount';
import { cn } from '@/lib/utils';

type GainLossLabels = {
  gain: string;
  loss: string;
  neutral: string;
};

type GainLossProps = {
  amountMinor: number;
  labels: GainLossLabels;
  className?: string;
};

/**
 * Signe ET libellé, en plus de la couleur (~1 homme sur 12 ne distingue pas rouge/vert, écran
 * souvent lu en plein soleil). Le rouge (`text-danger`) est réservé aux anomalies réelles ailleurs
 * dans le produit — une perte normale n'en est pas une, elle rend en ambre (`text-warning`).
 * L'orange (`--accent`) reste la couleur de marque/action, jamais une alerte.
 */
export function GainLoss({ amountMinor, labels, className }: GainLossProps) {
  if (amountMinor > 0) {
    return (
      <span
        className={cn('inline-flex items-baseline gap-1.5 text-success', className)}
        data-testid="gain-loss"
      >
        <span aria-hidden="true">+</span>
        <Amount amountMinor={amountMinor} />
        <span className="text-sm font-medium">{labels.gain}</span>
      </span>
    );
  }

  if (amountMinor < 0) {
    return (
      <span
        className={cn('inline-flex items-baseline gap-1.5 text-warning', className)}
        data-testid="gain-loss"
      >
        <span aria-hidden="true">−</span>
        <Amount amountMinor={Math.abs(amountMinor)} />
        <span className="text-sm font-medium">{labels.loss}</span>
      </span>
    );
  }

  return (
    <span
      className={cn('inline-flex items-baseline gap-1.5 text-muted', className)}
      data-testid="gain-loss"
    >
      <Amount amountMinor={0} />
      <span className="text-sm font-medium">{labels.neutral}</span>
    </span>
  );
}
