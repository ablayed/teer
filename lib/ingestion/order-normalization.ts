import type { Json } from '@/lib/supabase/database.types';

export type FlexibleOrderAddress = {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
};

export function defaultOrderCurrency(currency: string | null | undefined): string {
  return currency ?? 'XOF';
}

export function isStaleOrderUpdate(
  incoming: string | null | undefined,
  stored: string | null | undefined,
): boolean {
  if (!incoming || !stored) {
    return false;
  }
  return Date.parse(incoming) <= Date.parse(stored);
}

export function mapFlexibleOrderAddress(
  address: FlexibleOrderAddress | null | undefined,
): Json | null {
  if (!address) {
    return null;
  }

  const raw = [address.address1, address.address2, address.city, address.province]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(', ');

  return {
    raw: raw || null,
    landmark: address.address2 ?? null,
    quartier: null,
    city: address.city ?? null,
    region: address.province ?? null,
    notes: null,
  };
}
