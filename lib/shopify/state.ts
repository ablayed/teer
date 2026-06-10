import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type ShopifyOAuthStatePayload = {
  nonce: string;
  merchantAccountId: string;
  shopDomain: string;
  exp: number;
  // Multi-app : client_id de l'app Shopify choisie à l'install, relu au callback pour sélectionner
  // le bon secret (HMAC + échange de token). Optionnel pour rester rétrocompatible avec un state
  // émis avant le déploiement multi-app (le callback retombe alors sur l'app par défaut).
  clientId?: string;
};

function getShopifyApiSecret(): string {
  const secret = process.env.SHOPIFY_API_SECRET;

  if (!secret) {
    throw new Error('SHOPIFY_API_SECRET is required to sign Shopify OAuth state');
  }

  return secret;
}

function signPayload(base64Payload: string, secret: string): string {
  return createHmac('sha256', secret).update(base64Payload).digest('hex');
}

function isStatePayload(value: unknown): value is ShopifyOAuthStatePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.nonce === 'string' &&
    typeof record.merchantAccountId === 'string' &&
    typeof record.shopDomain === 'string' &&
    typeof record.exp === 'number' &&
    Number.isFinite(record.exp) &&
    (record.clientId === undefined || typeof record.clientId === 'string')
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

export function generateNonce(): string {
  return randomBytes(16).toString('hex');
}

export function signState(payload: ShopifyOAuthStatePayload): string {
  const base64Payload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = signPayload(base64Payload, getShopifyApiSecret());

  return `${base64Payload}.${signature}`;
}

export function verifyState(token: string): ShopifyOAuthStatePayload | null {
  const [base64Payload, signature, extra] = token.split('.');

  if (!base64Payload || !signature || extra !== undefined) {
    return null;
  }

  const expectedSignature = signPayload(base64Payload, getShopifyApiSecret());

  if (!safeCompareHex(signature, expectedSignature)) {
    return null;
  }

  try {
    const payload: unknown = JSON.parse(Buffer.from(base64Payload, 'base64url').toString('utf8'));

    if (!isStatePayload(payload) || payload.exp < Date.now()) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
