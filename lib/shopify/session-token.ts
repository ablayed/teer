import { createHmac, timingSafeEqual } from 'node:crypto';
import { validateShopDomain } from '@/lib/shopify/oauth';

const CLOCK_SKEW_SECONDS = 60;

export type ShopifySessionTokenClaims = {
  aud: string;
  dest: string;
  exp: number;
  iat: number;
  iss: string;
  nbf: number;
  sub: string;
};

export type SessionTokenVerification =
  | { ok: true; claims: ShopifySessionTokenClaims; shopDomain: string }
  | {
      ok: false;
      reason:
        | 'malformed'
        | 'unsupported_algorithm'
        | 'invalid_signature'
        | 'invalid_claims'
        | 'expired'
        | 'invalid_shop';
    };

type SessionTokenVerifyOptions = {
  clientId: string;
  clientSecret: string;
  nowMs?: number;
  clockSkewSeconds?: number;
};

function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readFiniteNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readNonEmptyString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function getShopDomainFromDest(dest: string): string | null {
  try {
    const url = new URL(dest);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.port) {
      return null;
    }

    const shopDomain = url.hostname.toLowerCase();
    return validateShopDomain(shopDomain) ? shopDomain : null;
  } catch {
    return null;
  }
}

function claimsFromPayload(payload: Record<string, unknown>): ShopifySessionTokenClaims | null {
  const aud = readNonEmptyString(payload, 'aud');
  const dest = readNonEmptyString(payload, 'dest');
  const iss = readNonEmptyString(payload, 'iss');
  const sub = readNonEmptyString(payload, 'sub');
  const exp = readFiniteNumber(payload, 'exp');
  const iat = readFiniteNumber(payload, 'iat');
  const nbf = readFiniteNumber(payload, 'nbf');

  if (!aud || !dest || !iss || !sub || exp === null || iat === null || nbf === null) {
    return null;
  }

  return { aud, dest, exp, iat, iss, nbf, sub };
}

export function extractShopifySessionAudience(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }

  return readNonEmptyString(decodeJsonSegment(parts[1]) ?? {}, 'aud');
}

export function verifyShopifySessionToken(
  token: string,
  options: SessionTokenVerifyOptions,
): SessionTokenVerification {
  const parts = token.split('.');
  if (
    parts.length !== 3 ||
    !/^[A-Za-z0-9_-]+$/.test(parts[0] ?? '') ||
    !/^[A-Za-z0-9_-]+$/.test(parts[1] ?? '') ||
    !/^[A-Za-z0-9_-]+$/.test(parts[2] ?? '')
  ) {
    return { ok: false, reason: 'malformed' };
  }

  const header = decodeJsonSegment(parts[0]);
  const payload = decodeJsonSegment(parts[1]);
  if (!header || !payload) {
    return { ok: false, reason: 'malformed' };
  }

  if (header.alg !== 'HS256' || header.typ !== 'JWT') {
    return { ok: false, reason: 'unsupported_algorithm' };
  }

  const expectedSignature = createHmac('sha256', options.clientSecret)
    .update(`${parts[0]}.${parts[1]}`, 'ascii')
    .digest();
  const providedSignature = Buffer.from(parts[2], 'base64url');
  if (
    providedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(providedSignature, expectedSignature)
  ) {
    return { ok: false, reason: 'invalid_signature' };
  }

  const claims = claimsFromPayload(payload);
  if (!claims || claims.aud !== options.clientId) {
    return { ok: false, reason: 'invalid_claims' };
  }

  const shopDomain = getShopDomainFromDest(claims.dest);
  if (!shopDomain || claims.iss !== `${claims.dest}/admin`) {
    return { ok: false, reason: 'invalid_shop' };
  }

  const nowSeconds = (options.nowMs ?? Date.now()) / 1000;
  const clockSkewSeconds = options.clockSkewSeconds ?? CLOCK_SKEW_SECONDS;

  if (claims.exp <= nowSeconds) {
    return { ok: false, reason: 'expired' };
  }

  if (
    claims.nbf > nowSeconds + clockSkewSeconds ||
    claims.iat > nowSeconds + clockSkewSeconds ||
    claims.iat > claims.exp ||
    claims.nbf > claims.exp
  ) {
    return { ok: false, reason: 'invalid_claims' };
  }

  return { ok: true, claims, shopDomain };
}
