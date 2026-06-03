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
