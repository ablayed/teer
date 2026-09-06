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
//
// Phase 2 / Clôture : l'orchestration DB (créer vs faire tourner, MÊME public_id) vit désormais
// dans scripts/lib/webhook-token-provisioning.mjs. rotateWebhookToken() y garde le comportement
// historique de CE script (« créer ou tourner » en une seule commande opérateur) ;
// webhook-subscription-migration.mjs --apply, lui, n'appelle JAMAIS rotateWebhookToken —
// uniquement createWebhookToken (jamais de rotation en effet de bord d'une mutation automatique).

import { createClient } from '@supabase/supabase-js';
import { assertMaintenanceSupabaseHttpTarget } from '../lib/security/supabase-target-policy.ts';
import { ROTATION_GRACE_MS, rotateWebhookToken } from './lib/webhook-token-provisioning.mjs';

function log(...args) {
  // biome-ignore lint/suspicious/noConsole: script CLI, sa sortie EST le livrable.
  console.log(...args);
}

function logError(...args) {
  // biome-ignore lint/suspicious/noConsole: script CLI, sa sortie EST le livrable.
  console.error(...args);
}

const storeConnectionId = process.argv[2];

if (!storeConnectionId) {
  logError(
    'l3-generate-webhook-token: usage: node scripts/l3-generate-webhook-token.mjs <store_connection_id>',
  );
  process.exit(1);
}

const url = process.env.L3_MAINTENANCE_SUPABASE_URL;
const serviceRoleKey = process.env.L3_MAINTENANCE_SUPABASE_SERVICE_ROLE_KEY;
const allowedTarget = process.env.L3_MAINTENANCE_SUPABASE_ALLOWED_ORIGIN;

if (!url || !serviceRoleKey) {
  logError('l3-generate-webhook-token: configuration de maintenance dédiée requise.');
  process.exit(1);
}

assertMaintenanceSupabaseHttpTarget({
  target: url,
  variableName: 'L3_MAINTENANCE_SUPABASE_URL',
  allowedTarget,
  allowedVariableName: 'L3_MAINTENANCE_SUPABASE_ALLOWED_ORIGIN',
});

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

  const { publicId, secret, mode } = await rotateWebhookToken(admin, storeConnectionId);
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
