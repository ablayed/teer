// Phase 2 — orchestration DB partagée pour le jeton d'URL opaque d'une store_connection
// (matériaux purs : lib/ingestion/webhook-token.ts). Extrait de scripts/l3-generate-webhook-token.mjs
// pour être réutilisé tel quel par scripts/webhook-subscription-migration.mjs (--apply) — même
// logique de rotation, jamais une seconde implémentation.
//
// Le secret en clair n'est JAMAIS écrit en base (seule son empreinte sha256 l'est, migration 0143)
// et n'est renvoyé qu'à l'appelant courant, en mémoire — c'est à l'appelant de ne jamais le logger
// ni le persister ailleurs.

import { generateWebhookToken, hashWebhookTokenSecret } from '../../lib/ingestion/webhook-token.ts';

// Fenêtre de grâce d'une rotation : bien en-deçà du plafond dur de 30 jours (contrainte 0143).
export const ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;

// Crée (si aucune ligne n'existe pour cette store_connection) ou fait tourner (si une ligne existe
// déjà) le jeton — MÊME public_id à travers une rotation (l'URL reste stable, seul secret_hash
// change), motif documenté dans 0143. Renvoie { publicId, secret, mode }.
export async function ensureWebhookToken(admin, storeConnectionId) {
  const { data: existing, error: existingError } = await admin
    .from('store_connection_webhook_token')
    .select('id, public_id, secret_hash')
    .eq('store_connection_id', storeConnectionId)
    .maybeSingle();

  if (existingError) {
    throw new Error(`store_connection_webhook_token lookup failed: ${existingError.message}`);
  }

  const generated = generateWebhookToken();

  if (existing) {
    const { error: updateError } = await admin
      .from('store_connection_webhook_token')
      .update({
        secret_hash: generated.secretHash,
        previous_secret_hash: existing.secret_hash,
        previous_secret_expires_at: new Date(Date.now() + ROTATION_GRACE_MS).toISOString(),
        rotated_at: new Date().toISOString(),
      })
      .eq('id', existing.id);

    if (updateError) {
      throw new Error(`rotation update failed: ${updateError.message}`);
    }

    return { publicId: existing.public_id, secret: generated.secret, mode: 'rotate' };
  }

  const { error: insertError } = await admin.from('store_connection_webhook_token').insert({
    store_connection_id: storeConnectionId,
    public_id: generated.publicId,
    secret_hash: generated.secretHash,
  });

  if (insertError) {
    throw new Error(`insert failed: ${insertError.message}`);
  }

  return { publicId: generated.publicId, secret: generated.secret, mode: 'create' };
}

// Réexport pour les appelants qui veulent vérifier une empreinte sans repasser par
// lib/ingestion/webhook-token.ts directement (évite un second point d'import du même module).
export { hashWebhookTokenSecret };
