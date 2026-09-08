// APP-03 / Lot 2 — continuation stateless du rattachement Teer Public embarqué. Réutilise le
// PATTERN cryptographique de `lib/shopify/state.ts` (HMAC-SHA256, payload base64url + signature
// hex, expiration) SANS toucher ce module ni son type : le state OAuth legacy est utilisé par les
// 4 apps historiques et reste inchangé. `purpose` est un discriminant explicite, jamais déduit de
// la forme — un state OAuth (qui porte toujours `merchantAccountId`) et cette continuation (qui
// n'en porte JAMAIS, le tenant n'étant résolu qu'après le login top-level) doivent rester
// mutuellement irrecevables dans les deux sens, prouvé par test de confusion dédié.
//
// Pas d'opacité recherchée : cette continuation ne transporte ni tenant ni secret, seulement
// shopDomain + clientId + host + exp — seule l'INTÉGRITÉ (signature) compte, pour empêcher un
// attaquant de forger une cible de rattachement (boutique/app arbitraire) sur l'écran de
// confirmation. Rejouable pendant sa courte durée de validité (pas de nonce à usage unique) :
// l'utilisateur peut recharger l'écran de confirmation sans relancer tout le parcours.
import { createHmac, timingSafeEqual } from 'node:crypto';

const INTENT_PURPOSE = 'embedded_link_intent' as const;

export type EmbeddedLinkIntentPayload = {
  purpose: typeof INTENT_PURPOSE;
  shopDomain: string;
  clientId: string;
  host: string;
  exp: number;
};

function getSigningSecret(): string {
  const secret = process.env.SHOPIFY_API_SECRET;

  if (!secret) {
    throw new Error('SHOPIFY_API_SECRET is required to sign the embedded link intent');
  }

  return secret;
}

function sign(base64Payload: string, secret: string): string {
  return createHmac('sha256', secret).update(base64Payload).digest('hex');
}

function isEmbeddedLinkIntentPayload(value: unknown): value is EmbeddedLinkIntentPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    record.purpose === INTENT_PURPOSE &&
    typeof record.shopDomain === 'string' &&
    typeof record.clientId === 'string' &&
    typeof record.host === 'string' &&
    typeof record.exp === 'number' &&
    Number.isFinite(record.exp)
  );
}

function safeCompareHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]+$/i.test(left) || !/^[0-9a-f]+$/i.test(right)) {
    return false;
  }

  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function signEmbeddedLinkIntent(
  payload: Omit<EmbeddedLinkIntentPayload, 'purpose'>,
): string {
  const fullPayload: EmbeddedLinkIntentPayload = { ...payload, purpose: INTENT_PURPOSE };
  const base64Payload = Buffer.from(JSON.stringify(fullPayload), 'utf8').toString('base64url');
  const signature = sign(base64Payload, getSigningSecret());

  return `${base64Payload}.${signature}`;
}

export function verifyEmbeddedLinkIntent(token: string): EmbeddedLinkIntentPayload | null {
  const [base64Payload, signature, extra] = token.split('.');

  if (!base64Payload || !signature || extra !== undefined) {
    return null;
  }

  const expectedSignature = sign(base64Payload, getSigningSecret());

  if (!safeCompareHex(signature, expectedSignature)) {
    return null;
  }

  try {
    const payload: unknown = JSON.parse(Buffer.from(base64Payload, 'base64url').toString('utf8'));

    if (!isEmbeddedLinkIntentPayload(payload) || payload.exp < Date.now()) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
