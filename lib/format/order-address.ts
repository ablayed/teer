import type { Json } from '@/lib/supabase/database.types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Adresse de livraison lisible à partir du jsonb shipping_address (address1..country).
// Partagé entre la liste commandes et l'action d'assignation (message WhatsApp livreur).
export function formatOrderAddress(value: Json | null): string | null {
  if (!isRecord(value)) {
    return null;
  }

  const parts = [
    stringField(value, 'address1'),
    stringField(value, 'address2'),
    stringField(value, 'city'),
    stringField(value, 'province'),
    stringField(value, 'country'),
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(', ') : null;
}
