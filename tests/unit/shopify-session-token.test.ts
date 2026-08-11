import { createHmac } from 'node:crypto';
import {
  extractShopifySessionAudience,
  verifyShopifySessionToken,
} from '@/lib/shopify/session-token';
import { describe, expect, it } from 'vitest';

const clientId = 'synthetic-client-id';
const secret = 'synthetic-session-secret';
const nowMs = Date.parse('2026-08-08T12:00:00.000Z');

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function token(overrides: Record<string, unknown> = {}, signingSecret = secret): string {
  const header = base64url({ alg: 'HS256', typ: 'JWT' });
  const payload = base64url({
    aud: clientId,
    dest: 'https://synthetic-shop.myshopify.com',
    exp: nowMs / 1000 + 60,
    iat: nowMs / 1000 - 10,
    iss: 'https://synthetic-shop.myshopify.com/admin',
    nbf: nowMs / 1000 - 10,
    sub: 'synthetic-user',
    ...overrides,
  });
  const signature = createHmac('sha256', signingSecret)
    .update(`${header}.${payload}`)
    .digest('base64url');

  return `${header}.${payload}.${signature}`;
}

function verify(value: string) {
  return verifyShopifySessionToken(value, { clientId, clientSecret: secret, nowMs });
}

describe('Shopify embedded session tokens', () => {
  it('accepts a valid token and extracts the shop from dest', () => {
    const result = verify(token());

    expect(result).toMatchObject({ ok: true, shopDomain: 'synthetic-shop.myshopify.com' });
    expect(extractShopifySessionAudience(token())).toBe(clientId);
  });

  it('rejects an expired token', () => {
    expect(verify(token({ exp: nowMs / 1000 - 1 }))).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a token signed for another app', () => {
    expect(verify(token({ aud: 'another-client-id' }))).toEqual({
      ok: false,
      reason: 'invalid_claims',
    });
  });

  it('rejects a token with an altered signature', () => {
    const value = token();
    expect(verify(`${value.slice(0, -1)}${value.endsWith('a') ? 'b' : 'a'}`)).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
  });

  it('rejects cross-shop claims and malformed or truncated tokens', () => {
    expect(verify(token({ iss: 'https://other-shop.myshopify.com/admin' }))).toEqual({
      ok: false,
      reason: 'invalid_shop',
    });
    expect(verify(token().split('.').slice(0, 2).join('.'))).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects a non-HS256 JWT before claim processing', () => {
    const header = base64url({ alg: 'none', typ: 'JWT' });
    const payload = base64url({ aud: clientId });
    const signature = createHmac('sha256', secret)
      .update(`${header}.${payload}`)
      .digest('base64url');

    expect(verify(`${header}.${payload}.${signature}`)).toEqual({
      ok: false,
      reason: 'unsupported_algorithm',
    });
  });
});
