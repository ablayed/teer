// Helpers purs d'enrichissement client (Phase 7b). Hors fichier `'use server'` : ces exports
// non-async ne peuvent pas vivre dans lib/actions/customers.ts (server action file).

import type { Json } from '@/lib/supabase/database.types';

// Seuil de signalement « refus répétés » : 2+ commandes REFUSEE. refused_count est déjà dérivé
// à la volée par la RPC 0014 (cod_status='REFUSEE') — pas de compteur stocké concurrent.
export const REFUSAL_THRESHOLD = 2;

// Récurrence : forte valeur COD (meilleur taux de livraison). Dérivée du nombre de commandes
// Tëër du client — pas de colonne stockée.
export function isRecurringCustomer(orderCount: number): boolean {
  return orderCount > 1;
}

// Refuseur répété : refused_count (cod_status='REFUSEE', dérivé) au-delà du seuil.
export function isRefuserCustomer(refusedCount: number): boolean {
  return refusedCount >= REFUSAL_THRESHOLD;
}

function asRecord(value: Json | null | undefined): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function addressPart(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Adresse d'affichage : on privilégie l'adresse flexible (raw, ou repère/quartier/ville/région),
// sinon l'adresse de livraison Shopify. Adressage sénégalais informel : pas de code postal.
export function formatCustomerAddress(address: Json | null, shipping: Json | null): string | null {
  const flexible = asRecord(address);
  if (flexible) {
    const raw = addressPart(flexible, 'raw');
    if (raw) {
      return raw;
    }
    const parts = [
      addressPart(flexible, 'landmark'),
      addressPart(flexible, 'quartier'),
      addressPart(flexible, 'city'),
      addressPart(flexible, 'region'),
    ].filter((part): part is string => Boolean(part));
    if (parts.length > 0) {
      return parts.join(', ');
    }
  }

  const shippingRecord = asRecord(shipping);
  if (shippingRecord) {
    const parts = [
      addressPart(shippingRecord, 'address1'),
      addressPart(shippingRecord, 'address2'),
      addressPart(shippingRecord, 'city'),
      addressPart(shippingRecord, 'province'),
    ].filter((part): part is string => Boolean(part));
    if (parts.length > 0) {
      return parts.join(', ');
    }
  }

  return null;
}
