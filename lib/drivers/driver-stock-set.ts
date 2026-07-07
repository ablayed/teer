// Lot 4b+4c / PR 2 : logique pure de décision pour "Modifier le stock" livreur.
// Extraite de setDriverStockAction pour rester unit-testable sans mocker
// Supabase (même raison que lib/orders/assignment-stock-check.ts, Lot 2).
//
// Saisie en VALEUR ABSOLUE ("le livreur a maintenant X") — le delta vs. le
// stock physique actuel est calculé ici, jamais accepté brut du client.
// Deux gardes bloquantes, exclusives (au plus une s'applique, selon le signe
// du delta) :
//   - augmentation (delta > 0) : bloquée si le stock central ne couvre pas.
//   - diminution   (delta < 0) : bloquée si elle dépasse ce que le livreur a
//     physiquement (jamais négatif, contrairement au stock DISPONIBLE du Lot 2
//     qui peut l'être légitimement).

export type DriverStockSetPlan =
  | { kind: 'noop' }
  | { kind: 'apply'; delta: number }
  | { kind: 'blocked'; reason: 'central'; missingQty: number }
  | { kind: 'blocked'; reason: 'physical'; currentQty: number; excessQty: number };

export function computeDriverStockSetPlan(params: {
  currentQty: number;
  newQty: number;
  centralAvailable: number;
}): DriverStockSetPlan {
  const { currentQty, newQty, centralAvailable } = params;
  const delta = newQty - currentQty;

  if (delta === 0) {
    return { kind: 'noop' };
  }

  if (delta > 0) {
    if (delta > centralAvailable) {
      return { kind: 'blocked', reason: 'central', missingQty: delta - centralAvailable };
    }
    return { kind: 'apply', delta };
  }

  const requestedDecrease = Math.abs(delta);
  if (requestedDecrease > currentQty) {
    return {
      kind: 'blocked',
      reason: 'physical',
      currentQty,
      excessQty: requestedDecrease - currentQty,
    };
  }
  return { kind: 'apply', delta };
}
