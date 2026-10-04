// SHOPIFY-WEBHOOKS-PER-SHOP-1B / C6 — horodatage et marge de la désinstallation ORDONNÉE
// (G6, G9, H1).
//
// Module pur : aucune dépendance d'environnement, aucun import.

// G9 — marge de comparaison entre l'horodatage d'un événement `app/uninstalled` et la borne
// d'acquisition des credentials. VALEUR PROVISOIRE, choix de politique : elle couvre UNIQUEMENT
// l'écart d'horloge entre Shopify et la base (H2, hypothèse acceptée et non démontrée), jamais le
// délai applicatif, que la borne basse de G5 traite. Elle est passée en paramètre à la primitive,
// jamais figée en SQL.
//
// Coût annoncé : dans les secondes de la marge qui suivent un événement, une ancienne livraison
// peut encore supprimer une attente ou désinstaller une installation nouvelle. Issue récupérable :
// rouvrir Tëër depuis l'admin Shopify.
export const SHOPIFY_UNINSTALL_ORDER_MARGIN_SECONDS = 10;

export type TriggeredAtAnomaly = 'absent' | 'unreadable' | 'future';

export type ParsedTriggeredAt =
  | { readonly value: string; readonly anomaly: null }
  | { readonly value: null; readonly anomaly: TriggeredAtAnomaly };

// Horodatage ISO 8601 complet, avec fuseau explicite. `Date.parse` seul accepterait des formes
// lâches (« 2026 », « Oct 3 ») qui ne sont pas un horodatage Shopify.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

// Vrai si la valeur a la forme d'un horodatage ISO 8601 complet. Sert aussi à décider ce qui
// peut être écrit dans une colonne `timestamptz` : une valeur illisible y ferait échouer
// l'insertion entière.
export function isIsoTimestamp(raw: string | null | undefined): raw is string {
  return (
    typeof raw === 'string' && ISO_TIMESTAMP.test(raw.trim()) && Number.isFinite(Date.parse(raw))
  );
}

// H1 — `X-Shopify-Triggered-At` N'EST PAS SIGNÉ : le HMAC ne couvre que le corps brut. Il est
// accepté comme INDICATION D'ORDRE, jamais comme une preuve.
//
// Absent, illisible, ou postérieur à maintenant + la marge : il vaut NULL. La primitive traite
// alors l'événement par l'issue récupérable (désinstallation, suppression de l'attente), et
// l'appelant émet une sentinelle expurgée.
//
// La valeur rendue est la chaîne REÇUE, une fois validée : la base la lit avec sa propre
// précision, sans passer par celle, en millisecondes, d'une date JavaScript.
export function parseShopifyTriggeredAt(
  raw: string | null | undefined,
  nowMs: number,
  marginSeconds: number = SHOPIFY_UNINSTALL_ORDER_MARGIN_SECONDS,
): ParsedTriggeredAt {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return { value: null, anomaly: 'absent' };
  }
  if (!ISO_TIMESTAMP.test(trimmed)) {
    return { value: null, anomaly: 'unreadable' };
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) {
    return { value: null, anomaly: 'unreadable' };
  }
  if (timestamp > nowMs + marginSeconds * 1000) {
    return { value: null, anomaly: 'future' };
  }
  return { value: trimmed, anomaly: null };
}
