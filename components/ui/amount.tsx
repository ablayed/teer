import { formatFCFACompact, formatMoney } from '@/lib/format/fcfa';
import { cn } from '@/lib/utils';

type AmountProps = {
  amountMinor: number;
  /**
   * Abréviation (`1,2 M`) réservée aux axes de graphe — jamais un montant de trésorerie.
   * Nommé explicitement pour documenter cet usage prévu plutôt qu'un raccourci générique.
   */
  abbreviateForAxis?: boolean;
  className?: string;
};

/**
 * Seul composant du produit pour un montant en francs CFA. Enveloppe `formatMoney`
 * (lib/format/fcfa.ts) sans réimplémenter le formatage. Sans-serif, chiffres tabulaires
 * mesurés (voir tests/e2e/lot-u1f-tabular-nums.spec.ts) — jamais la police display, jamais
 * l'italique.
 */
export function Amount({ amountMinor, abbreviateForAxis, className }: AmountProps) {
  const formatted = abbreviateForAxis ? formatFCFACompact(amountMinor) : formatMoney(amountMinor);

  return (
    <span className={cn('font-sans tabular-nums lining-nums', className)} data-testid="amount">
      {formatted}
    </span>
  );
}
