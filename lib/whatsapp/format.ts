import { formatMoney } from '@/lib/format/fcfa';
import type { Json } from '@/lib/supabase/database.types';
import { normalizeWhatsAppSenegalPhone } from '@/lib/whatsapp/link';

export type WhatsappOrderItem = {
  nom: string;
  quantite: number;
};

export type WhatsappOrderData = {
  adresse: string | null | undefined;
  items: WhatsappOrderItem[];
  numeroCommande: string | null | undefined;
  telephone: string | null | undefined;
  total: number | null | undefined;
};

const VALEUR_MANQUANTE = '—';

export function safeText(value: string | null | undefined): string {
  const v = value?.trim();
  return v && v.length > 0 ? v : VALEUR_MANQUANTE;
}

export function formatProduits(items: WhatsappOrderItem[] | null | undefined): string {
  if (!items || items.length === 0) return VALEUR_MANQUANTE;
  const lines = items.filter((it) => it?.nom).map((it) => `${it.quantite}x ${it.nom}`);
  return lines.length > 0 ? lines.join('\n') : VALEUR_MANQUANTE;
}

/**
 * Total formate pour WhatsApp. Delegue au formateur FCFA existant et retire
 * l'espace fine insecable (U+202F) qui s'affiche mal dans WhatsApp.
 * (Deplace depuis lib/whatsapp/link.ts.)
 */
export function formatMoneyForWhatsApp(
  amount: number | null | undefined,
  currency?: string | null,
): string {
  if (amount == null || Number.isNaN(amount)) return VALEUR_MANQUANTE;
  // String.fromCharCode(0x202F) = narrow no-break space emitted by Intl.NumberFormat
  return formatMoney(amount, currency ?? undefined)
    .split(String.fromCharCode(0x202f))
    .join(' ');
}

/**
 * Parse le JSON items_summary en WhatsappOrderItem[].
 * Utilise en liste (OrderListItem) et dans le dialog livreur.
 */
export function parseItemsSummaryForWhatsapp(value: Json | null | undefined): WhatsappOrderItem[] {
  if (!Array.isArray(value)) return [];
  const items: WhatsappOrderItem[] = [];
  for (const item of value) {
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      const nom = typeof record.title === 'string' ? record.title.trim() : '';
      const quantite =
        typeof record.quantity === 'number' && Number.isFinite(record.quantity)
          ? Math.max(Math.round(record.quantity), 0)
          : 0;
      if (nom) items.push({ nom, quantite });
    }
  }
  return items;
}

/**
 * Lien WhatsApp SANS destinataire : ouvre le selecteur de chat de WhatsApp.
 * L'utilisateur choisit le contact ou le groupe, le texte est pre-rempli, rien n'est envoye.
 */
export function buildWhatsappShareUrl(message: string): string {
  return `https://api.whatsapp.com/send?text=${encodeURIComponent(message)}`;
}

/**
 * Sujet 1.3 — lien WhatsApp AVEC destinataire : ouvre directement la conversation
 * du client (`wa.me/<E.164 sans +>`), texte pré-rempli, rien n'est envoyé.
 *
 * Le bouton « Message client » passait par `buildWhatsappShareUrl` (sélecteur de
 * chat, sans destinataire) : l'agent devait retrouver le contact à la main. Le
 * numéro est normalisé (indicatif 221, 0 initial et 00 international retirés,
 * séparateurs supprimés) par `normalizeWhatsAppSenegalPhone`.
 *
 * Repli explicite sur le sélecteur de chat quand le numéro n'est pas un mobile
 * sénégalais normalisable : un `wa.me/<numéro invalide>` ouvre une page d'erreur
 * WhatsApp, strictement pire que le comportement actuel.
 */
export function buildWhatsappDirectUrl(phone: string | null | undefined, message: string): string {
  const normalized = normalizeWhatsAppSenegalPhone(phone);

  if (!normalized) {
    return buildWhatsappShareUrl(message);
  }

  return `https://wa.me/${normalized}?text=${encodeURIComponent(message)}`;
}
