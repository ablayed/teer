// Calcul de l'ETA d'un lot fournisseur en jours ouvrés (lundi–vendredi).
// Les jours fériés sénégalais (variables/lunaires) sont couverts par
// l'override manuel eta_override — aucune liste de fériés hardcodée.

export type PurchaseLotForEta = {
  ordered_at: string; // YYYY-MM-DD
  supplier_prep_days: number;
  transport_days: number;
  local_buffer_days: number;
  eta_override: string | null; // YYYY-MM-DD, gagne sur tout calcul
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
  if (lot.eta_override) {
    return parseDateLocal(lot.eta_override);
  }
  const start = parseDateLocal(lot.ordered_at);
  const totalDays = lot.supplier_prep_days + lot.transport_days + lot.local_buffer_days;
  return addBusinessDays(start, totalDays);
}

// Formate une Date en YYYY-MM-DD (affichage, pas de conversion TZ).
export function formatEtaDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
