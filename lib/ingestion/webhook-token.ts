// Phase 2 / Lot L3 (périmètre réduit) — matériaux du jeton d'URL opaque par installation.
//
// Pur : aucun import Supabase ici. La génération produit le secret en clair UNE SEULE FOIS (jamais
// stocké) ; seule son empreinte (sha256) est destinée à être persistée. `public_id` sert de clé de
// recherche (pas un secret en soi — le rôle de key id, comme un client_id) ; la confidentialité
// tient entièrement à `secret`/`secretHash`.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const PUBLIC_ID_BYTES = 16;
const SECRET_BYTES = 32;
const TOKEN_SEPARATOR = '.';

export type GeneratedWebhookToken = {
  readonly publicId: string;
  readonly secret: string;
  readonly secretHash: string;
  // Forme complète à placer dans l'URL : `${publicId}${TOKEN_SEPARATOR}${secret}`.
  readonly raw: string;
};

export type ParsedWebhookToken = {
  readonly publicId: string;
  readonly secret: string;
};

export function hashWebhookTokenSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function generateWebhookToken(): GeneratedWebhookToken {
  const publicId = randomBytes(PUBLIC_ID_BYTES).toString('base64url');
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const secretHash = hashWebhookTokenSecret(secret);

  return { publicId, secret, secretHash, raw: `${publicId}${TOKEN_SEPARATOR}${secret}` };
}

// Un seul split, sur le PREMIER séparateur : `public_id` (base64url) ne peut structurellement pas
// contenir le séparateur, mais on ne suppose jamais l'inverse pour `secret`.
export function parseWebhookToken(raw: string): ParsedWebhookToken | null {
  const separatorIndex = raw.indexOf(TOKEN_SEPARATOR);

  if (separatorIndex <= 0 || separatorIndex === raw.length - 1) {
    return null;
  }

  const publicId = raw.slice(0, separatorIndex);
  const secret = raw.slice(separatorIndex + 1);

  if (!publicId || !secret) {
    return null;
  }

  return { publicId, secret };
}

// Comparaison à temps constant. Les empreintes SHA-256 ont toujours la même longueur (32 octets) ;
// la garde de longueur reste nécessaire (timingSafeEqual lève si les tailles diffèrent), pas un
// raccourci de sécurité — un `storedHash` corrompu/mal formé ne doit jamais faire planter l'appelant.
export function verifyWebhookTokenSecret(secret: string, storedHash: string): boolean {
  let candidate: Buffer;
  let stored: Buffer;

  try {
    candidate = Buffer.from(hashWebhookTokenSecret(secret), 'hex');
    stored = Buffer.from(storedHash, 'hex');
  } catch {
    return false;
  }

  if (candidate.length !== stored.length) {
    return false;
  }

  return timingSafeEqual(candidate, stored);
}
