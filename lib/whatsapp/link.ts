import { formatMoney } from '@/lib/format/fcfa';
import type { Json } from '@/lib/supabase/database.types';

const SENEGAL_DIAL_CODE = '221';
const MOBILE_PREFIXES = ['70', '75', '76', '77', '78', '79'] as const;

export type WhatsAppOrderInput = {
  address: string | null;
  currency: string | null;
  customerFirstName: string | null;
  itemsSummary: Json | null;
  orderNumber: string | null;
  phone: string | null;
  shopName: string;
  totalAmount: number;
};

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

export function normalizeWhatsAppSenegalPhone(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  let digits = digitsOnly(value.trim());

  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  if (digits.startsWith(SENEGAL_DIAL_CODE)) {
    digits = digits.slice(SENEGAL_DIAL_CODE.length);
  }

  if (digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  if (!/^\d{9}$/.test(digits)) {
    return null;
  }

  if (!MOBILE_PREFIXES.some((prefix) => digits.startsWith(prefix))) {
    return null;
  }

  return `${SENEGAL_DIAL_CODE}${digits}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function firstName(fullName: string | null | undefined): string {
  return fullName?.trim().split(/\s+/)[0] || 'client';
}

export function formatMoneyForWhatsApp(
  amount: number,
  currency: string | null | undefined,
): string {
  return formatMoney(amount, currency).replace(/\u202F/g, ' ');
}

function itemLines(itemsSummary: Json | null): string[] {
  if (!Array.isArray(itemsSummary)) {
    return [];
  }

  return itemsSummary
    .map((item) => {
      if (!isRecord(item)) {
        return null;
      }

      const title = stringField(item, 'title');
      const quantity = Math.max(Math.round(numberField(item, 'quantity')), 0);

      if (!title) {
        return null;
      }

      return quantity > 1 ? `- ${quantity} x ${title}` : `- ${title}`;
    })
    .filter((line): line is string => line !== null);
}

export function buildWhatsAppConfirmationMessage(order: WhatsAppOrderInput): string {
  const lines = itemLines(order.itemsSummary);
  const address = order.address?.trim() || 'votre adresse';

  return [
    `Bonjour ${order.customerFirstName ?? 'client'}, c'est ${order.shopName}`,
    `Nous confirmons votre commande n°${order.orderNumber ?? ''} :`,
    lines.length > 0 ? lines.join('\n') : '- Articles de votre commande',
    `Total à payer à la livraison : ${formatMoneyForWhatsApp(order.totalAmount, order.currency)}`,
    `Souhaitez-vous confirmer la livraison à ${address} ?`,
    'Merci de répondre OUI pour valider.',
  ].join('\n');
}

export function buildWhatsAppConfirmationUrl(order: WhatsAppOrderInput): string | null {
  const phone = normalizeWhatsAppSenegalPhone(order.phone);

  if (!phone) {
    return null;
  }

  return `https://wa.me/${phone}?text=${encodeURIComponent(
    buildWhatsAppConfirmationMessage(order),
  )}`;
}

// Message d'expedition : les donnees de la commande a transmettre au livreur
// (client, telephone, adresse/repere, articles, total a encaisser, n° commande).
export function buildWhatsAppDispatchMessage(order: WhatsAppOrderInput): string {
  const lines = itemLines(order.itemsSummary);

  return [
    `Commande n°${order.orderNumber ?? ''}`,
    `Client : ${order.customerFirstName ?? 'client'}`,
    order.phone ? `Tél : ${order.phone}` : null,
    `Adresse : ${order.address?.trim() || 'adresse à confirmer'}`,
    'Articles :',
    lines.length > 0 ? lines.join('\n') : '- Articles de la commande',
    `Total à encaisser : ${formatMoneyForWhatsApp(order.totalAmount, order.currency)}`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

// Lien wa.me SANS numero : le marchand choisit le destinataire (livreur) dans
// WhatsApp. Toujours disponible des qu'on a une commande a transmettre.
export function buildWhatsAppDispatchUrl(order: WhatsAppOrderInput): string {
  return `https://wa.me/?text=${encodeURIComponent(buildWhatsAppDispatchMessage(order))}`;
}
