import { normalizeSenegalPhone, toSenegalNationalDigits } from '@/lib/address/phone-sn';
import type { Json } from '@/lib/supabase/database.types';

type OrderSearchShape = {
  customer: {
    full_name: string | null;
    phone: string | null;
  } | null;
  items_summary: Json | null;
};

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];

  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function orderItemsSearchText(itemsSummary: Json | null): string {
  if (!Array.isArray(itemsSummary)) {
    return '';
  }

  const titles: string[] = [];

  for (const item of itemsSummary) {
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      const title = stringField(item, 'title');

      if (title) {
        titles.push(title.toLowerCase());
      }
    }
  }

  return titles.join(' ');
}

export function normalizeOrderSearch(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

export function matchesOrderSearch(order: OrderSearchShape, rawSearch: string): boolean {
  const search = normalizeOrderSearch(rawSearch);

  if (!search) {
    return true;
  }

  const searchDigits = digitsOnly(rawSearch);
  const normalizedSearchPhone = normalizeSenegalPhone(rawSearch);
  const customerName = order.customer?.full_name?.toLowerCase() ?? '';
  const productText = orderItemsSearchText(order.items_summary);

  if (customerName.includes(search) || productText.includes(search)) {
    return true;
  }

  const phone = order.customer?.phone;

  if (!phone) {
    return false;
  }

  const normalizedPhone = normalizeSenegalPhone(phone) ?? phone;
  const phoneLower = normalizedPhone.toLowerCase();

  if (normalizedSearchPhone && phoneLower === normalizedSearchPhone.toLowerCase()) {
    return true;
  }

  if (!searchDigits) {
    return phoneLower.includes(search);
  }

  const phoneDigits = digitsOnly(normalizedPhone);
  const nationalDigits = toSenegalNationalDigits(phone);

  return phoneDigits.includes(searchDigits) || nationalDigits.includes(searchDigits);
}

export function filterOrdersBySearch<T extends OrderSearchShape>(orders: T[], search: string): T[] {
  return orders.filter((order) => matchesOrderSearch(order, search));
}

// Fix de triage (freeze /commandes à la recherche) : le chemin de recherche legacy
// (lib/actions/orders.ts:listOrdersForPageData) bornait auparavant zéro date et chargeait tout
// l'historique du marchand — cf. gotcha CLAUDE.md dédié. Bornage temporaire à 12 mois glissants,
// en attendant la RPC de recherche SQL paginée (lot séparé). Isolé ici (fichier pur, aucun import
// de `lib/env.ts`/client Supabase) pour rester unit-testable sans mocker tout l'environnement.
export const LEGACY_SEARCH_LOOKBACK_MONTHS = 12;

export function legacySearchLookbackIso(referenceDate: Date = new Date()): string {
  const cutoff = new Date(referenceDate);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - LEGACY_SEARCH_LOOKBACK_MONTHS);
  return cutoff.toISOString();
}
