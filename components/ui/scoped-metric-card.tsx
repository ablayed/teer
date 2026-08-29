import { cn } from '@/lib/utils';
import { CalendarRange, Clock } from 'lucide-react';
import type * as React from 'react';

/**
 * Deux familles à ne jamais confondre : un solde à une date (argent chez le livreur, invendu)
 * et un flux sur une période (CA, marge). Partagé avec ExplanationCard.
 */
export type TemporalScope =
  | { kind: 'balance'; asOfLabel: string }
  | { kind: 'flow'; periodLabel: string };

type ScopedMetricCardProps = {
  label: string;
  value: React.ReactNode;
  /** Obligatoire — une carte sans portée temporelle ne doit pas compiler. */
  scope: TemporalScope;
  delta?: React.ReactNode;
  className?: string;
};

function ScopeSubtitle({ scope }: { scope: TemporalScope }) {
  if (scope.kind === 'balance') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-muted">
        <Clock aria-hidden="true" className="size-3.5 shrink-0" />
        {`Solde au ${scope.asOfLabel}`}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-muted">
      <CalendarRange aria-hidden="true" className="size-3.5 shrink-0" />
      {`Sur ${scope.periodLabel}`}
    </span>
  );
}

export function ScopedMetricCard({ label, value, scope, delta, className }: ScopedMetricCardProps) {
  return (
    <div
      className={cn(
        // `min-w-0` : sans lui, un grid/flex item garde `min-width: auto` par défaut — le
        // contenu intrinsèque (un montant large) peut alors élargir toute la colonne de la
        // grille au lieu de déclencher le défilement horizontal interne voulu sur la valeur
        // (`overflow-x-auto` ci-dessous), débordant le viewport sur mobile étroit (412/390px).
        '@container/scoped-stat min-w-0 rounded-lg border border-border bg-surface p-3 @min-[10rem]/scoped-stat:p-4',
        className,
      )}
    >
      <p className="text-xs font-medium text-muted @min-[10rem]/scoped-stat:text-sm">{label}</p>
      {/* Jamais `truncate` ici : une valeur monétaire ne se coupe jamais (voir
          tests/e2e/lot-u1f-money-no-truncation.spec.ts). Si la carte est trop étroite pour le
          montant, la ligne défile horizontalement au lieu de perdre des chiffres — le montant
          reste intégralement présent et atteignable, jamais silencieusement caché. */}
      <p className="mt-1 overflow-x-auto whitespace-nowrap text-2xl font-semibold text-text @min-[10rem]/scoped-stat:text-3xl">
        {value}
      </p>
      <div className="mt-1">
        <ScopeSubtitle scope={scope} />
      </div>
      {delta ? <div className="mt-1 text-xs text-muted">{delta}</div> : null}
    </div>
  );
}
