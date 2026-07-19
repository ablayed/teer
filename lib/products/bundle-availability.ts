// Disponibilité dérivée d'un produit bundle (Bundles PR 2).
//
// Un bundle (product.is_bundle = true) n'a plus de qty_on_hand propre
// significatif : sa cascade (PR 1, post_stock_movement) redirige tout mouvement
// de stock en scope vers ses composants. Sa disponibilité affichée doit donc
// être DÉRIVÉE de celle de ses composants, jamais lue depuis product_stock du
// bundle lui-même.
//
// Formule (décision validée, Phase B) : pour chaque composant,
// disponible_composant = qty_on_hand - qty_reserved (PAS de plancher à 0 — un
// composant en déficit doit faire chuter la disponibilité du bundle, signal
// utile, jamais masqué, cohérent avec le principe déjà établi sur ce projet
// pour /livreurs). Le nombre de bundles assemblables pour ce composant est
// floor(disponible_composant / quantité_requise). La disponibilité du bundle
// est le MIN sur tous ses composants (le plus restrictif).
//
// Math.floor sur un nombre négatif arrondit vers -Infinity (ex. floor(-1/2) =
// -1, pas 0) — cohérent avec "aucun plancher" : un déficit composant se
// traduit par une disponibilité bundle négative, pas nulle.

export type BundleComponentRequirement = {
  componentProductId: string;
  quantity: number;
};

export type ComponentStockLevel = {
  productId: string;
  qtyOnHand: number;
  qtyReserved: number;
};

/**
 * Disponibilité dérivée d'un seul bundle à partir de ses composants.
 * Retourne `null` si le bundle n'a aucun composant configuré (rien à dériver
 * — cas de composition incomplète, pas une valeur numérique valide).
 */
export function computeBundleDerivedAvailability(
  components: BundleComponentRequirement[],
  stockByComponentId: Map<string, ComponentStockLevel>,
): number | null {
  if (components.length === 0) return null;

  let min: number | null = null;
  for (const component of components) {
    const stock = stockByComponentId.get(component.componentProductId);
    const qtyOnHand = stock?.qtyOnHand ?? 0;
    const qtyReserved = stock?.qtyReserved ?? 0;
    const available = qtyOnHand - qtyReserved;
    const assemblable = Math.floor(available / component.quantity);
    if (min === null || assemblable < min) {
      min = assemblable;
    }
  }
  return min;
}

export type BundleCompositionRow = {
  bundleProductId: string;
  componentProductId: string;
  quantity: number;
};

/**
 * Disponibilité dérivée pour PLUSIEURS bundles à la fois — groupe les lignes
 * de composition par bundle, puis applique computeBundleDerivedAvailability
 * à chacun. Retourne une Map bundleProductId → disponibilité (ou null).
 */
export function deriveBundleAvailabilities(
  compositionRows: BundleCompositionRow[],
  stockByComponentId: Map<string, ComponentStockLevel>,
): Map<string, number | null> {
  const byBundle = new Map<string, BundleComponentRequirement[]>();
  for (const row of compositionRows) {
    const list = byBundle.get(row.bundleProductId) ?? [];
    list.push({ componentProductId: row.componentProductId, quantity: row.quantity });
    byBundle.set(row.bundleProductId, list);
  }

  const result = new Map<string, number | null>();
  for (const [bundleProductId, components] of byBundle) {
    result.set(bundleProductId, computeBundleDerivedAvailability(components, stockByComponentId));
  }
  return result;
}
