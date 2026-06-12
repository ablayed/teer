// Calcul de l'ETA d'un lot fournisseur en jours ouvrés (lundi–vendredi).
// Les jours fériés sénégalais (variables/lunaires) ne sont pas modélisés : le
// marchand ajuste le « délai estimé » à la hausse si une période fériée tombe
// dans le transit.
//
// Lot C : l'ETA est désormais pilotée par UN seul champ « délai estimé »
// (estimated_lead_time_days), en remplacement des trois composantes
// (prep + transport + buffer) et de l'override.

export type PurchaseLotForEta = {
  ordered_at: string; // YYYY-MM-DD
  estimated_lead_time_days: number; // jours ouvrés à partir de ordered_at
};

// Parse une date ISO sans conversion de fuseau horaire (évite l'effet
// "veille" quand le runtime est en UTC et la date est stockée sans heure).
function parseDateLocal(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day);
}

// Avance de `days` jours ouvrés (lundi–vendredi) à partir de `startDate`.
// Si days = 0, retourne startDate inchangé.
export function addBusinessDays(startDate: Date, days: number): Date {
  const result = new Date(startDate);
  let remaining = days;
  while (remaining > 0) {
    result.setDate(result.getDate() + 1);
    const dow = result.getDay(); // 0 = dimanche, 6 = samedi
    if (dow !== 0 && dow !== 6) {
      remaining--;
    }
  }
  return result;
}

export function computeEta(lot: PurchaseLotForEta): Date {
  const start = parseDateLocal(lot.ordered_at);
  return addBusinessDays(start, Math.max(0, lot.estimated_lead_time_days));
}

// Formate une Date en YYYY-MM-DD (affichage, pas de conversion TZ).
export function formatEtaDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
