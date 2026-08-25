#!/usr/bin/env node
// Phase 2 / Lot L3 (périmètre réduit) — génère (ou fait tourner) le jeton d'URL opaque d'une
// store_connection existante.
//
// Le secret en clair n'existe QUE dans la sortie de ce script, une seule fois — jamais stocké
// (seule son empreinte sha256 l'est, migration 0143). Il n'y a donc aucun moyen de le retrouver
// après coup : le noter immédiatement, ou relancer ce script pour une rotation.
//
// Usage :
//   node scripts/l3-generate-webhook-token.mjs <store_connection_id>          # crée ou fait tourner
//   node scripts/l3-generate-webhook-token.mjs <store_connection_id> --rotate # explicite, même effet
//
// Nécessite NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (local ou linked). N'écrit QUE
// dans store_connection_webhook_token — jamais dans store_connection ni ailleurs.

import { createHash, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const PUBLIC_ID_BYTES = 16;
const SECRET_BYTES = 32;
const ROTATION_GRACE_MS = 24 * 60 * 60 * 1000; // 24h — bien en-deçà du plafond dur de 30 jours (0143).

function log(...args) {
  // biome-ignore lint/suspicious/noConsole: script CLI, sa sortie EST le livrable.
  console.log(...args);
}

function logError(...args) {
  // biome-ignore lint/suspicious/noConsole: script CLI, sa sortie EST le livrable.
  console.error(...args);
}

function hashSecret(secret) {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function generateSecret() {
  return randomBytes(SECRET_BYTES).toString('base64url');
}

const storeConnectionId = process.argv[2];

if (!storeConnectionId) {
  logError(
    'l3-generate-webhook-token: usage: node scripts/l3-generate-webhook-token.mjs <store_connection_id>',
  );
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  logError(
    'l3-generate-webhook-token: NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY requis.',
  );
  process.exit(1);
}

const admin = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  const { data: connection, error: connectionError } = await admin
    .from('store_connection')
    .select('id, platform, external_identifier, status')
    .eq('id', storeConnectionId)
    .maybeSingle();

  if (connectionError) {
    throw new Error(`store_connection lookup failed: ${connectionError.message}`);
  }
  if (!connection) {
    logError(`l3-generate-webhook-token: aucune store_connection avec id=${storeConnectionId}.`);
    process.exit(1);
  }

  const { data: existing, error: existingError } = await admin
    .from('store_connection_webhook_token')
    .select('id, public_id, secret_hash')
    .eq('store_connection_id', storeConnectionId)
    .maybeSingle();

  if (existingError) {
    throw new Error(`store_connection_webhook_token lookup failed: ${existingError.message}`);
  }

  const secret = generateSecret();
  const secretHash = hashSecret(secret);

  let publicId;
  let mode;

  if (existing) {
    // Rotation : MÊME public_id (URL stable), ancien secret déplacé en previous_secret_hash avec
    // une fenêtre de grâce bornée. Jamais une seconde ligne pour la même connexion (contrainte
    // unique(store_connection_id), 0143).
    publicId = existing.public_id;
    mode = 'rotate';
    const { error: updateError } = await admin
      .from('store_connection_webhook_token')
      .update({
        secret_hash: secretHash,
        previous_secret_hash: existing.secret_hash,
        previous_secret_expires_at: new Date(Date.now() + ROTATION_GRACE_MS).toISOString(),
        rotated_at: new Date().toISOString(),
      })
      .eq('id', existing.id);

    if (updateError) {
      throw new Error(`rotation update failed: ${updateError.message}`);
    }
  } else {
    publicId = randomBytes(PUBLIC_ID_BYTES).toString('base64url');
    mode = 'create';
    const { error: insertError } = await admin.from('store_connection_webhook_token').insert({
      store_connection_id: storeConnectionId,
      public_id: publicId,
      secret_hash: secretHash,
    });

    if (insertError) {
      throw new Error(`insert failed: ${insertError.message}`);
    }
  }

  const rawToken = `${publicId}.${secret}`;

  log(`l3-generate-webhook-token: mode=${mode} store_connection_id=${storeConnectionId}`);
  log(
    `l3-generate-webhook-token: platform=${connection.platform} external_identifier=${connection.external_identifier}`,
  );
  log('l3-generate-webhook-token: jeton en clair (unique affichage, à noter immédiatement) :');
  log(rawToken);
  if (mode === 'rotate') {
    log(
      `l3-generate-webhook-token: ancien secret encore accepté jusqu'à ${new Date(Date.now() + ROTATION_GRACE_MS).toISOString()}.`,
    );
  }
}

main().catch((error) => {
  logError('l3-generate-webhook-token: échec', error);
  process.exit(1);
});
