import { Amount } from '@/components/ui/amount';
import { cn } from '@/lib/utils';
import { CircleDashed, TriangleAlert } from 'lucide-react';

/**
 * Type discriminé — pas un objet permissif. `missing` ne PEUT PAS porter de montant ni de
 * valeur dérivée (la propriété n'existe pas sur cette branche du type), `estimated` EXIGE son
 * libellé. Preuve de compilation : tests/types/value-state-contracts.ts.
 */
export type MoneyValueState =
  | { kind: 'confirmed'; amountMinor: number }
  | { kind: 'estimated'; amountMinor: number; label: string }
  | { kind: 'missing'; label?: string };

const DEFAULT_MISSING_LABEL = 'Non renseigné';

type ValueAmountProps = {
  state: MoneyValueState;
  /** Libellé de repli si `state.kind === 'missing'` ne porte pas de `label`. */
  missingLabel?: string;
  className?: string;
};

/**
 * Le libellé et l'icône portent l'information — jamais la couleur ou l'italique seuls.
 */
export function ValueAmount({ state, missingLabel, className }: ValueAmountProps) {
  if (state.kind === 'confirmed') {
    return (
      <span className={cn('inline-flex items-baseline', className)}>
        <Amount amountMinor={state.amountMinor} />
      </span>
    );
  }

  if (state.kind === 'estimated') {
    return (
      <span
        className={cn('inline-flex items-center gap-1.5 text-warning', className)}
        data-testid="value-state-estimated"
      >
        <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
        <span className="inline-flex items-baseline gap-1">
          <span aria-hidden="true">~</span>
          <Amount amountMinor={state.amountMinor} />
        </span>
        <span className="text-sm">{state.label}</span>
      </span>
    );
  }

  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-muted', className)}
      data-testid="value-state-missing"
    >
      <CircleDashed aria-hidden="true" className="size-4 shrink-0" />
      <span aria-hidden="true">—</span>
      <span className="text-sm">{state.label ?? missingLabel ?? DEFAULT_MISSING_LABEL}</span>
    </span>
  );
}
