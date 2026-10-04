// SHOPIFY-WEBHOOKS-PER-SHOP-1B / C1 — provisionnement et rotation du jeton d'URL opaque d'une
// store_connection (matériaux purs : lib/ingestion/webhook-token.ts ; table : 0143).
//
// Jusqu'à ce lot, ces écritures n'existaient que dans des scripts d'opérateur. Elles vivent ici
// pour que la réconciliation des abonnements (lib/shopify/webhook-subscription-reconcile.ts) soit
// leur SEUL appelant. Format inchangé : `publicId.secret`, seule l'empreinte sha256 du secret est
// stockée.
//
// Discipline du secret : le secret en clair n'existe qu'en mémoire, dans la valeur rendue à
// l'appelant, le temps de l'enregistrement chez Shopify. Il n'est ni écrit, ni journalisé, ni
// placé dans un message d'erreur.
//
// Deux modes de rotation, NOMMÉS :
//   installation  sans grâce — l'empreinte précédente et son échéance passent à NULL. Shopify a
//                 supprimé les abonnements à la désinstallation : aucune livraison ne peut encore
//                 viser l'ancienne URL ;
//   repair        avec grâce de 24 h — l'ancienne empreinte reste acceptée, parce que des
//                 livraisons peuvent encore viser l'ancienne URL.
//
// Fencing : toute rotation est un compare-and-set sur l'empreinte LUE par l'appelant. Si un autre
// détenteur a tourné le jeton entre-temps, zéro ligne est écrite et l'appelant s'arrête.
import { generateWebhookToken } from '@/lib/ingestion/webhook-token';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

type AdminClient = SupabaseClient<Database>;

// Fenêtre de grâce d'une rotation de réparation : bien en deçà du plafond dur de 30 jours (0143).
export const WEBHOOK_TOKEN_REPAIR_GRACE_MS = 24 * 60 * 60 * 1000;

export type WebhookTokenRotationMode = 'installation' | 'repair';

export type WebhookTokenRow = {
  readonly id: string;
  readonly publicId: string;
  readonly secretHash: string;
  readonly previousSecretHash: string | null;
  readonly previousSecretExpiresAt: string | null;
  readonly revokedAt: string | null;
};

export type ReadWebhookTokenResult =
  | { ok: true; row: WebhookTokenRow | null }
  | { ok: false; reason: 'read_failed' };

export async function readWebhookToken(
  admin: AdminClient,
  storeConnectionId: string,
): Promise<ReadWebhookTokenResult> {
  const { data, error } = await admin
    .from('store_connection_webhook_token')
    .select(
      'id, public_id, secret_hash, previous_secret_hash, previous_secret_expires_at, revoked_at',
    )
    .eq('store_connection_id', storeConnectionId)
    .maybeSingle();

  if (error) {
    return { ok: false, reason: 'read_failed' };
  }
  if (!data) {
    return { ok: true, row: null };
  }
  return {
    ok: true,
    row: {
      id: data.id,
      publicId: data.public_id,
      secretHash: data.secret_hash,
      previousSecretHash: data.previous_secret_hash,
      previousSecretExpiresAt: data.previous_secret_expires_at,
      revokedAt: data.revoked_at,
    },
  };
}

// Ce que l'inventaire Shopify dit des abonnements qui ne portent PAS l'empreinte courante.
export type RotationInventorySignals = {
  // Au moins un abonnement porte l'empreinte précédente.
  readonly hasPrevious: boolean;
  // Au moins un abonnement vise notre origine sans être reconnu (ni courant, ni précédent).
  readonly hasForeignOnOurOrigin: boolean;
};

// Choix du mode. Il ne se déduit JAMAIS de la seule absence d'abonnement courant, qui peut aussi
// signaler une réparation.
//   - le mode est DÉCLARÉ par l'appelant (finalisation → installation ; relance manuelle et cron →
//     repair) ;
//   - `installation` ne s'applique que si l'inventaire ne contient aucun abonnement précédent ni
//     aucun abonnement non reconnu vers notre origine. Sinon des livraisons peuvent encore viser
//     l'ancienne URL : le mode bascule en `repair`, avec grâce.
export function resolveRotationMode(
  declared: WebhookTokenRotationMode,
  signals: RotationInventorySignals,
): WebhookTokenRotationMode {
  if (declared === 'repair') {
    return 'repair';
  }
  return signals.hasPrevious || signals.hasForeignOnOurOrigin ? 'repair' : 'installation';
}

export type ProvisionedWebhookToken = {
  readonly publicId: string;
  // En clair, en mémoire seulement.
  readonly secret: string;
  readonly secretHash: string;
  readonly grace: boolean;
};

export type ProvisionWebhookTokenResult =
  | { ok: true; token: ProvisionedWebhookToken }
  | { ok: false; reason: 'conflict' | 'write_failed' };

// Première provision : une connexion qui n'a encore AUCUNE ligne de jeton. Une ligne créée
// concurremment (contrainte d'unicité par connexion) rend `conflict`, jamais un écrasement.
export async function createWebhookToken(
  admin: AdminClient,
  storeConnectionId: string,
): Promise<ProvisionWebhookTokenResult> {
  const generated = generateWebhookToken();
  const { error } = await admin.from('store_connection_webhook_token').insert({
    store_connection_id: storeConnectionId,
    public_id: generated.publicId,
    secret_hash: generated.secretHash,
  });

  if (error) {
    return { ok: false, reason: error.code === '23505' ? 'conflict' : 'write_failed' };
  }

  return {
    ok: true,
    token: {
      publicId: generated.publicId,
      secret: generated.secret,
      secretHash: generated.secretHash,
      grace: false,
    },
  };
}

export type RotateWebhookTokenInput = {
  // La ligne telle que l'appelant l'a LUE : son empreinte est la valeur attendue du
  // compare-and-set.
  row: WebhookTokenRow;
  mode: WebhookTokenRotationMode;
  // Mode `repair` seulement. Vrai quand l'inventaire porte encore des abonnements sur l'empreinte
  // PRÉCÉDENTE : c'est elle qui reste en grâce, et non l'empreinte courante, qu'aucun abonnement
  // n'utilise (rotation interrompue avant l'enregistrement chez Shopify). Sans cela, une seconde
  // rotation évincerait la seule empreinte encore en service.
  keepPreviousInGrace?: boolean;
  now?: Date;
};

// Rotation : MÊME `public_id` (URL stable), nouveau secret. `revoked_at` est remis à NULL
// EXPLICITEMENT : une connexion réactivée après une libération d'identité (qui révoque le jeton,
// lib/shopify/app-release-write.ts) redevient résoluble.
//
// Une ligne révoquée ne garde JAMAIS son ancienne empreinte en grâce, quel que soit le mode : un
// secret révoqué ne redevient pas valide par une rotation.
export async function rotateWebhookToken(
  admin: AdminClient,
  input: RotateWebhookTokenInput,
): Promise<ProvisionWebhookTokenResult> {
  const now = input.now ?? new Date();
  const generated = generateWebhookToken();
  const withGrace = input.mode === 'repair' && input.row.revokedAt === null;
  const graceHash =
    withGrace && input.keepPreviousInGrace && input.row.previousSecretHash
      ? input.row.previousSecretHash
      : input.row.secretHash;

  const { data, error } = await admin
    .from('store_connection_webhook_token')
    .update({
      secret_hash: generated.secretHash,
      previous_secret_hash: withGrace ? graceHash : null,
      previous_secret_expires_at: withGrace
        ? new Date(now.getTime() + WEBHOOK_TOKEN_REPAIR_GRACE_MS).toISOString()
        : null,
      rotated_at: now.toISOString(),
      revoked_at: null,
    })
    .eq('id', input.row.id)
    // Compare-and-set : l'empreinte doit être celle que l'appelant a lue.
    .eq('secret_hash', input.row.secretHash)
    .select('id');

  if (error) {
    return { ok: false, reason: 'write_failed' };
  }
  if ((data ?? []).length === 0) {
    return { ok: false, reason: 'conflict' };
  }

  return {
    ok: true,
    token: {
      publicId: input.row.publicId,
      secret: generated.secret,
      secretHash: generated.secretHash,
      grace: withGrace,
    },
  };
}
