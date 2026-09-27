import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ShopifyAppLabel } from '@/lib/shopify/app-registry';

export const SHOPIFY_NON_EMBEDDED_INTENT_COOKIE = 'shopify_non_embedded_install_intent';
export const SHOPIFY_NON_EMBEDDED_INTENT_TTL_SECONDS = 5 * 60;

const INTENT_PURPOSE = 'shopify_non_embedded_install' as const;

export type ShopifyNonEmbeddedInstallIntent = {
  purpose: typeof INTENT_PURPOSE;
  appLabel: ShopifyAppLabel;
  shop: string;
  exp: number;
};

function signature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function signShopifyNonEmbeddedInstallIntent(
  input: { appLabel: ShopifyAppLabel; shop: string },
  secret: string,
  now = Date.now(),
): string {
  const intent: ShopifyNonEmbeddedInstallIntent = {
    purpose: INTENT_PURPOSE,
    appLabel: input.appLabel,
    shop: input.shop,
    exp: now + SHOPIFY_NON_EMBEDDED_INTENT_TTL_SECONDS * 1000,
  };
  const encoded = Buffer.from(JSON.stringify(intent), 'utf8').toString('base64url');
  return `${encoded}.${signature(encoded, secret)}`;
}

export function readShopifyNonEmbeddedIntentLabel(token: string): string | null {
  const [encoded, providedSignature, extra] = token.split('.');
  if (!encoded || !providedSignature || extra !== undefined) return null;

  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const label = (value as Record<string, unknown>).appLabel;
    return typeof label === 'string' ? label : null;
  } catch {
    return null;
  }
}

export function verifyShopifyNonEmbeddedInstallIntent(
  token: string,
  secret: string,
  now = Date.now(),
): ShopifyNonEmbeddedInstallIntent | null {
  const [encoded, providedSignature, extra] = token.split('.');
  if (
    !encoded ||
    !providedSignature ||
    extra !== undefined ||
    !/^[0-9a-f]{64}$/i.test(providedSignature)
  ) {
    return null;
  }

  const expected = Buffer.from(signature(encoded, secret), 'hex');
  const provided = Buffer.from(providedSignature, 'hex');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      record.purpose !== INTENT_PURPOSE ||
      typeof record.appLabel !== 'string' ||
      typeof record.shop !== 'string' ||
      typeof record.exp !== 'number' ||
      !Number.isFinite(record.exp) ||
      record.exp <= now ||
      record.exp > now + SHOPIFY_NON_EMBEDDED_INTENT_TTL_SECONDS * 1000
    ) {
      return null;
    }

    return record as ShopifyNonEmbeddedInstallIntent;
  } catch {
    return null;
  }
}
