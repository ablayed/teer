import type { MoneyValueState } from '@/components/ui/value-state';

/**
 * Preuve de compilation pour la preuve 5.2/5.3 (Phase F · Lot U1-F). Ce fichier n'est PAS un
 * test vitest (pas de suffixe .test.ts, `pnpm test:unit` ne le charge pas) — c'est `pnpm
 * typecheck` (tsc --noEmit, tsconfig.json inclut tous les fichiers .ts) qui le vérifie. Chaque
 * `@ts-expect-error` DOIT correspondre à une vraie erreur : si l'usage invalide devient valide,
 * la directive inutilisée fait échouer tsc elle-même ("Unused '@ts-expect-error' directive").
 */

// Usages valides — doivent compiler sans erreur.
const confirmed: MoneyValueState = { kind: 'confirmed', amountMinor: 12_500 };
const estimated: MoneyValueState = {
  kind: 'estimated',
  amountMinor: 50_000,
  label: 'Coût à confirmer',
};
const missing: MoneyValueState = { kind: 'missing' };
const missingWithLabel: MoneyValueState = { kind: 'missing', label: 'Non renseigné' };

// Manquant NE PEUT PAS porter de montant — le typage doit rejeter l'excès de propriété.
// @ts-expect-error — `missing` ne porte jamais `amountMinor`.
const invalidMissing: MoneyValueState = { kind: 'missing', amountMinor: 1_000 };

// Estimé EXIGE son libellé — impossible de l'omettre.
// @ts-expect-error — `estimated` sans `label` doit être rejeté.
const invalidEstimated: MoneyValueState = { kind: 'estimated', amountMinor: 50_000 };

// Narrowing de contrôle de flux : `amountMinor` n'existe pas sur la branche `missing`, même en
// accédant via une variable déjà typée (pas seulement au moment de la construction littérale).
function readAmountIfMissing(state: MoneyValueState) {
  if (state.kind === 'missing') {
    // @ts-expect-error — `amountMinor` n'existe pas sur la branche `missing`.
    return state.amountMinor;
  }
  return state.amountMinor;
}

// Évite les avertissements "déclaré mais jamais lu" sans changer la nature des preuves ci-dessus.
export const __valueStateContractFixtures = {
  confirmed,
  estimated,
  missing,
  missingWithLabel,
  invalidMissing,
  invalidEstimated,
  readAmountIfMissing,
};
