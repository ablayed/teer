// SHOPIFY-OAUTH-FIRST-01 / D2 — ticket de rattachement d'une installation en attente.
//
// 256 bits tirés par `crypto.randomBytes`, transportés UNIQUEMENT par un cookie `httpOnly`,
// `SameSite=Lax`, restreint au chemin `/shopify/claim` (la page GET et son action POST). La base
// ne voit que l'empreinte sha256 en hexadécimal (`shopify_pending_installation.ticket_hash`).
// Le ticket en clair n'apparaît jamais dans une URL, un journal, un audit ni la télémétrie.
//
// Module pur : aucune dépendance d'environnement.
import { createHash, randomBytes } from 'node:crypto';

export const SHOPIFY_CLAIM_TICKET_COOKIE = 'shopify_claim_ticket';
export const SHOPIFY_CLAIM_PATH = '/shopify/claim';

// Plafond SQL de l'attente : 60 min (0160, `expiry_window`, D24), vérifié par
// `decide_and_write_shopify_authorization` contre l'horloge de la BASE. L'échéance est calculée
// ici avec l'horloge du serveur Node : viser exactement le plafond ferait refuser l'attente dès
// que Node avance de quelques millisecondes sur Postgres (écart de cet ordre mesuré en local).
// Une marge d'une minute absorbe ce décalage sans rien changer au plafond.
export const SHOPIFY_PENDING_TTL_MS = 59 * 60 * 1000;

const TICKET_BYTES = 32;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateShopifyClaimTicket(): string {
  return randomBytes(TICKET_BYTES).toString('base64url');
}

// Empreinte du ticket tel que le cookie le porte. Un ticket de forme invalide n'a pas
// d'empreinte : l'appelant le traite comme inconnu, sans interroger la base.
export function hashShopifyClaimTicket(ticket: string | null | undefined): string | null {
  if (!ticket || !TICKET_PATTERN.test(ticket)) {
    return null;
  }
  return createHash('sha256').update(ticket, 'utf8').digest('hex');
}

export function shopifyClaimTicketCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    // Même convention que le cookie de state OAuth (`/api/shopify/install`) : `Secure` en
    // production ; les E2E locaux tournent en HTTP.
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: SHOPIFY_CLAIM_PATH,
    maxAge: maxAgeSeconds,
  };
}
