'use client';

import { DetailPanel } from '@/components/ui/detail-panel';
import type { TemporalScope } from '@/components/ui/scoped-metric-card';
import { type MoneyValueState, ValueAmount } from '@/components/ui/value-state';
import { cn } from '@/lib/utils';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';

export type ExplanationCardRow = {
  /** Phrase déjà rédigée dans le langage du marchand (ex. "Tu as encaissé"). */
  sentence: string;
  sign: 'add' | 'subtract';
  state: MoneyValueState;
};

type ExplanationCardProps = {
  label: string;
  /** Phrase de la ligne de total (ex. "Il te reste"). */
  totalSentence: string;
  rows: ExplanationCardRow[];
  scope?: TemporalScope;
  className?: string;
};

const MISSING_TOTAL_LABEL = 'Il manque des coûts';
const ESTIMATED_TOTAL_LABEL = 'Coût à confirmer';

/**
 * Le total n'est jamais accepté en prop — il est dérivé des lignes. Une seule ligne `missing`
 * suffit à rendre le total `missing` : impossible de produire un total sur des lignes
 * incomplètes (preuve 5.6, tests/unit/ui/explanation-card.test.tsx).
 */
export function computeExplanationTotal(rows: ExplanationCardRow[]): MoneyValueState {
  if (rows.some((row) => row.state.kind === 'missing')) {
    return { kind: 'missing', label: MISSING_TOTAL_LABEL };
  }

  const amountMinor = rows.reduce((sum, row) => {
    // `row.state.kind` ne peut plus être 'missing' ici (garde ci-dessus), mais TS ne le sait
    // pas depuis un `.some()` externe à cette closure — narrowing explicite.
    if (row.state.kind === 'missing') {
      return sum;
    }
    const signedAmount = row.sign === 'subtract' ? -row.state.amountMinor : row.state.amountMinor;
    return sum + signedAmount;
  }, 0);

  if (rows.some((row) => row.state.kind === 'estimated')) {
    return { kind: 'estimated', amountMinor, label: ESTIMATED_TOTAL_LABEL };
  }

  return { kind: 'confirmed', amountMinor };
}

/**
 * Composant central du lot : fusionne la « carte à définition » (déclenchement discret, un seul
 * bouton) et le 3ᵉ niveau de la divulgation (ligne de calcul). La définition montre les nombres
 * du marchand en phrases, jamais une formule abstraite — components/ui/definition-card.tsx
 * (toujours utilisé par les écrans métier existants) n'est pas modifié par ce lot.
 */
export function ExplanationCard({
  label,
  totalSentence,
  rows,
  scope,
  className,
}: ExplanationCardProps) {
  const [open, setOpen] = useState(false);
  const total = computeExplanationTotal(rows);

  return (
    <div className={cn('rounded-lg border border-border bg-surface', className)}>
      <button
        aria-expanded={open}
        className="flex min-h-12 w-full items-center justify-between gap-3 rounded-lg px-4 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setOpen(true)}
        type="button"
      >
        {/* `truncate` ici est un choix, pas un effet de bord : `label` et le sous-titre de
            portée sont du texte libellé (jamais un chiffre), et cette ligne d'en-tête doit
            rester sur une seule ligne à côté du total + chevron. Le total lui-même
            (ValueAmount ci-dessous) n'a jamais `truncate` — voir scoped-metric-card.tsx pour
            le bug que ça a produit quand appliqué à un montant. */}
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-muted">{label}</span>
          {scope ? (
            <span className="block truncate text-xs text-muted">
              {scope.kind === 'balance'
                ? `Solde au ${scope.asOfLabel}`
                : `Sur ${scope.periodLabel}`}
            </span>
          ) : null}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1">
          <ValueAmount className="text-lg font-semibold text-text" state={total} />
          <ChevronRight aria-hidden="true" className="size-4 text-muted" />
        </span>
      </button>

      <DetailPanel closeLabel="Fermer" open={open} title={label} onClose={() => setOpen(false)}>
        <div className="space-y-3 p-4">
          {rows.map((row) => (
            <div className="flex items-baseline justify-between gap-4" key={row.sentence}>
              <span className="text-sm text-text">{row.sentence}</span>
              <ValueAmount className="shrink-0" state={row.state} />
            </div>
          ))}
          <div className="border-t border-border pt-3">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-sm font-semibold text-text">{totalSentence}</span>
              <ValueAmount className="shrink-0 text-base font-semibold" state={total} />
            </div>
          </div>
        </div>
      </DetailPanel>
    </div>
  );
}
