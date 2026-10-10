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

export type OrderUpdateRecency = 'older' | 'same' | 'newer' | 'unknown';

/**
 * Situe une mise à jour entrante par rapport à celle déjà appliquée. `isStaleOrderUpdate` confond
 * « plus ancienne » et « identique » ; le réimport a besoin de les séparer : une charge identique
 * peut encore réparer une commande restée sans lignes, une charge plus ancienne jamais.
 */
export function compareOrderUpdate(
  incoming: string | null | undefined,
  stored: string | null | undefined,
): OrderUpdateRecency {
  if (!incoming || !stored) {
    return 'unknown';
  }
  const incomingMs = Date.parse(incoming);
  const storedMs = Date.parse(stored);
  if (!Number.isFinite(incomingMs) || !Number.isFinite(storedMs)) {
    return 'unknown';
  }
  if (incomingMs < storedMs) {
    return 'older';
  }
  return incomingMs === storedMs ? 'same' : 'newer';
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
