// Phase 2 — orchestration DB partagée pour le jeton d'URL opaque d'une store_connection
// (matériaux purs : lib/ingestion/webhook-token.ts).
//
// Trois opérations DISTINCTES, volontairement séparées après l'incident d'idempotence trouvé en
// revue sur webhook-subscription-migration.mjs --apply (rapport de session dédié) : la version
// précédente de ce module exposait une seule fonction `ensureWebhookToken` qui FAISAIT TOURNER
// le secret dès qu'une ligne existait déjà — appelée sans discernement par --apply à chaque
// mutation nécessaire, elle invalidait silencieusement les URL déjà enregistrées côté Shopify
// pour TOUS les autres topics déjà conformes de la même connexion (le secret fait partie de
// l'URL ; seul public_id est stable à travers une rotation). Un mode censé être sûr à rejouer
// devenait celui qui coupait l'ingestion.
//
//   - getWebhookToken   : lecture seule, aucune mutation.
//   - createWebhookToken: crée une ligne pour une connexion qui n'en a AUCUNE. Échoue si une
//                         ligne existe déjà (jamais un écrasement implicite — utiliser
//                         rotateWebhookToken pour changer un secret existant).
//   - rotateWebhookToken: fait tourner le secret d'une connexion qui a déjà un jeton (MÊME
//                         public_id, URL stable ; ancien secret accepté durant la fenêtre de
//                         grâce) — ou en crée un si aucun n'existe, pour rester un point d'entrée
//                         robuste pour l3-generate-webhook-token.mjs (« créer ou tourner » en une
//                         seule commande opérateur, déjà son comportement historique).
//
// Le secret en clair n'est JAMAIS écrit en base (seule son empreinte sha256 l'est, migration
// 0143) et n'est renvoyé qu'à l'appelant courant, en mémoire — c'est à l'appelant de ne jamais
// le logger ni le persister ailleurs.

import { generateWebhookToken } from '../../lib/ingestion/webhook-token.ts';

// Fenêtre de grâce d'une rotation : bien en-deçà du plafond dur de 30 jours (contrainte 0143).
export const ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;

// Lecture seule. Renvoie la ligne existante (avec secret_hash, pour un appelant qui aurait
// besoin de vérifier une empreinte) ou null si aucun jeton n'a jamais été provisionné pour cette
// connexion.
export async function getWebhookToken(admin, storeConnectionId) {
  const { data, error } = await admin
    .from('store_connection_webhook_token')
    .select('id, public_id, secret_hash, revoked_at')
    .eq('store_connection_id', storeConnectionId)
    .maybeSingle();

  if (error) {
    throw new Error(`store_connection_webhook_token lookup failed: ${error.message}`);
  }

  return data;
}

// Provisionnement initial UNIQUEMENT. Lève si une ligne existe déjà pour cette connexion — un
// second appel n'écrase jamais silencieusement un secret déjà en usage.
export async function createWebhookToken(admin, storeConnectionId) {
  const existing = await getWebhookToken(admin, storeConnectionId);
  if (existing) {
    throw new Error(
      `createWebhookToken: un jeton existe déjà pour store_connection_id=${storeConnectionId} — utiliser rotateWebhookToken pour en changer le secret.`,
    );
  }

  const generated = generateWebhookToken();
  const { error } = await admin.from('store_connection_webhook_token').insert({
    store_connection_id: storeConnectionId,
    public_id: generated.publicId,
    secret_hash: generated.secretHash,
  });

  if (error) {
    throw new Error(`insert failed: ${error.message}`);
  }

  return { publicId: generated.publicId, secret: generated.secret, mode: 'create' };
}

// Fait tourner le secret d'une connexion — MÊME public_id (URL stable), ancien secret déplacé en
// previous_secret_hash avec fenêtre de grâce (motif documenté 0143). Crée si aucune ligne
// n'existe encore (même effet que createWebhookToken), pour rester un point d'entrée unique et
// robuste pour l'usage opérateur (l3-generate-webhook-token.mjs).
export async function rotateWebhookToken(admin, storeConnectionId) {
  const existing = await getWebhookToken(admin, storeConnectionId);
  const generated = generateWebhookToken();

  if (!existing) {
    const { error } = await admin.from('store_connection_webhook_token').insert({
      store_connection_id: storeConnectionId,
      public_id: generated.publicId,
      secret_hash: generated.secretHash,
    });

    if (error) {
      throw new Error(`insert failed: ${error.message}`);
    }

    return { publicId: generated.publicId, secret: generated.secret, mode: 'create' };
  }

  const { error } = await admin
    .from('store_connection_webhook_token')
    .update({
      secret_hash: generated.secretHash,
      previous_secret_hash: existing.secret_hash,
      previous_secret_expires_at: new Date(Date.now() + ROTATION_GRACE_MS).toISOString(),
      rotated_at: new Date().toISOString(),
    })
    .eq('id', existing.id);

  if (error) {
    throw new Error(`rotation update failed: ${error.message}`);
  }

  return { publicId: existing.public_id, secret: generated.secret, mode: 'rotate' };
}
