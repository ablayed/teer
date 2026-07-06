// Lot 2 / PR 3 : comparaison pure besoin×disponible pour l'alerte "Stock insuffisant"
// à l'assignation. Aucune E/S ici — les deux tableaux d'entrée sont déjà lus par les
// actions serveur (order_line agrégé / getDriverAvailableStock). Comparaison par
// produit, jamais un total global.

export type RequiredStockRow = {
  productId: string;
  title: string;
  requiredQty: number;
};

export type AvailableStockRow = {
  productId: string;
  qtyAvailable: number;
};

export type StockShortageRow = {
  productId: string;
  title: string;
  requiredQty: number;
  availableQty: number;
  missingQty: number;
};

export function computeStockShortages(
  required: RequiredStockRow[],
  available: AvailableStockRow[],
): StockShortageRow[] {
  const availableByProductId = new Map(available.map((row) => [row.productId, row.qtyAvailable]));

  const shortages: StockShortageRow[] = [];
  for (const line of required) {
    // Produit absent du disponible (jamais dans le ledger OU net exactement zéro,
    // les deux étant indiscernables côté lecture) → traité comme disponible = 0.
    const availableQty = availableByProductId.get(line.productId) ?? 0;
    const missingQty = Math.max(line.requiredQty - availableQty, 0);
    if (missingQty > 0) {
      shortages.push({
        productId: line.productId,
        title: line.title,
        requiredQty: line.requiredQty,
        availableQty,
        missingQty,
      });
    }
  }

  return shortages;
}
