// Formate un ratio (ex. 0.219) en pourcentage localisé fr-FR à une décimale,
// virgule décimale — jamais le point anglais de `.toFixed(1)`. Le signe « % »
// n'est PAS inclus : les appelants l'ajoutent eux-mêmes (cf.
// purchase-lot-detail-panel.tsx / purchase-lots-view.tsx, Lot F2).
export function formatPercentFr(ratio: number): string {
  return (ratio * 100).toLocaleString('fr-FR', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}
