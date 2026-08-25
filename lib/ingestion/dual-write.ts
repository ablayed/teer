// Phase 2 / Lot L2 — double écriture vers le registre canonique (ingestion_event/external_ref),
// en parallèle de `webhook_event` qui reste AUTORITATIVE en lecture dans ce lot (aucune bascule).
//
// Toutes les fonctions ici sont best-effort et NE DOIVENT JAMAIS faire échouer le chemin legacy :
// tout appelant doit envelopper ces appels et absorber leurs erreurs (le webhook_event existant
// reste la source de vérité tant que L2 n'a pas basculé la lecture). Elles ne sont donc jamais
// levantes — elles renvoient un résultat typé, jamais un throw.
import type { CanonicalEnvelope, ResolvedConnectionContext } from '@/lib/ingestion/canonical';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

type AdminClient = SupabaseClient<Database>;

type WriteIngestionEventInput = {
  ctx: ResolvedConnectionContext;
  topic: string;
  deliveryId: string | null;
  resourceKind: CanonicalEnvelope['kind'] | null;
  resourceExternalId: string | null;
  status: 'processing' | 'retryable' | 'terminal' | 'done';
  triggeredAt: string | null;
};

export async function writeIngestionEvent(
  supabase: AdminClient,
  input: WriteIngestionEventInput,
): Promise<{ ok: true; duplicate: boolean } | { ok: false; error: string }> {
  const { error } = await supabase.from('ingestion_event').insert({
    merchant_account_id: input.ctx.merchantAccountId,
    shop_id: input.ctx.shopId,
    store_connection_id: input.ctx.storeConnectionId,
    platform: input.ctx.platform,
    topic: input.topic,
    delivery_id: input.deliveryId,
    resource_kind: input.resourceKind,
    resource_external_id: input.resourceExternalId,
    status: input.status,
    triggered_at: input.triggeredAt,
  });

  if (error) {
    // 23505 : conflit sur l'index partiel unique (store_connection_id, platform, delivery_id) —
    // dédoublonnage attendu (rejeu), pas une panne. Un rejeu du même événement ne produit rien de
    // nouveau, exactement comme webhook_event.
    if (error.code === '23505') {
      return { ok: true, duplicate: true };
    }
    return { ok: false, error: error.message };
  }

  return { ok: true, duplicate: false };
}

type LinkExternalRefInput = {
  ctx: ResolvedConnectionContext;
  entityType: 'order' | 'customer' | 'product' | 'order_line';
  externalId: string;
  entityId: string;
};

// Collision (même store_connection_id, entity_type, external_id, mais entity_id DIFFÉRENT) →
// échec explicite, sans écrasement. L'entité d'origine reste intacte : cette fonction n'écrit
// jamais un UPDATE sur external_ref, seulement un INSERT — un conflit sur la contrainte unique ne
// touche donc structurellement jamais la ligne existante.
export async function linkExternalRef(
  supabase: AdminClient,
  input: LinkExternalRefInput,
): Promise<{ ok: true; alreadyLinked: boolean } | { ok: false; error: 'collision' | string }> {
  const { error } = await supabase.from('external_ref').insert({
    store_connection_id: input.ctx.storeConnectionId,
    entity_type: input.entityType,
    external_id: input.externalId,
    entity_id: input.entityId,
  });

  if (!error) {
    return { ok: true, alreadyLinked: false };
  }

  if (error.code !== '23505') {
    return { ok: false, error: error.message };
  }

  const { data: existing, error: readError } = await supabase
    .from('external_ref')
    .select('entity_id')
    .eq('store_connection_id', input.ctx.storeConnectionId)
    .eq('entity_type', input.entityType)
    .eq('external_id', input.externalId)
    .maybeSingle();

  if (readError || !existing) {
    return { ok: false, error: 'collision' };
  }

  if (existing.entity_id === input.entityId) {
    // Rejeu du même événement pour la même entité : idempotent, pas une collision.
    return { ok: true, alreadyLinked: true };
  }

  return { ok: false, error: 'collision' };
}

// orders.store_connection_id : ne pose la colonne que si elle est encore NULL — jamais un
// écrasement d'une valeur déjà posée (immutabilité de fait, cohérente avec le motif
// store_context_immutable déjà en place pour shop_id sur les autres tables scopées).
export async function setOrderStoreConnectionIfMissing(
  supabase: AdminClient,
  { ctx, orderId }: { ctx: ResolvedConnectionContext; orderId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase
    .from('orders')
    .update({ store_connection_id: ctx.storeConnectionId })
    .eq('id', orderId)
    .eq('merchant_account_id', ctx.merchantAccountId)
    .is('store_connection_id', null);

  if (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true };
}
