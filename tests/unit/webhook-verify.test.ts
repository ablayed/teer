import { createHmac } from 'node:crypto';
import { verifyWebhookHmac, verifyWebhookHmacAnySecret } from '@/lib/shopify/webhook-verify';
import { describe, expect, it } from 'vitest';

const secret = 'test_webhook_secret';
const rawBody = JSON.stringify({
  id: 123,
  topic: 'orders/create',
  total_price: '42.00',
});

function sign(body: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64');
}

describe('verifyWebhookHmac', () => {
  it('accepts a valid Shopify webhook HMAC', () => {
    expect(verifyWebhookHmac(rawBody, sign(rawBody), secret)).toBe(true);
  });

  it('rejects an invalid HMAC', () => {
    expect(verifyWebhookHmac(rawBody, sign(rawBody).replace('A', 'B'), secret)).toBe(false);
  });

  it.each([null, undefined, ''])('rejects a missing HMAC header: %s', (hmacHeader) => {
    expect(verifyWebhookHmac(rawBody, hmacHeader, secret)).toBe(false);
  });

  it('rejects a signature when the body is altered', () => {
    expect(verifyWebhookHmac(`${rawBody}\n`, sign(rawBody), secret)).toBe(false);
  });

  it('rejects signatures with different lengths', () => {
    expect(verifyWebhookHmac(rawBody, 'too-short', secret)).toBe(false);
  });
});

describe('verifyWebhookHmacAnySecret (multi-app)', () => {
  const devSecret = 'teer_dev_secret';
  const piloteSecret = 'teer_pilote_secret';
  const secrets = [devSecret, piloteSecret];

  function signWith(body: string, withSecret: string): string {
    return createHmac('sha256', withSecret).update(body, 'utf8').digest('base64');
  }

  it('accepts a webhook signed by either registered app secret', () => {
    expect(verifyWebhookHmacAnySecret(rawBody, signWith(rawBody, devSecret), secrets)).toBe(true);
    expect(verifyWebhookHmacAnySecret(rawBody, signWith(rawBody, piloteSecret), secrets)).toBe(
      true,
    );
  });

  it('rejects a webhook signed by an unregistered secret', () => {
    expect(verifyWebhookHmacAnySecret(rawBody, signWith(rawBody, 'autre_secret'), secrets)).toBe(
      false,
    );
  });

  it('rejects when no secrets are provided', () => {
    expect(verifyWebhookHmacAnySecret(rawBody, signWith(rawBody, devSecret), [])).toBe(false);
  });

  it.each([null, undefined, ''])('rejects a missing HMAC header: %s', (hmacHeader) => {
    expect(verifyWebhookHmacAnySecret(rawBody, hmacHeader, secrets)).toBe(false);
  });

  it('ignores empty-string secrets in the candidate list', () => {
    expect(verifyWebhookHmacAnySecret(rawBody, signWith(rawBody, devSecret), ['', devSecret])).toBe(
      true,
    );
    expect(verifyWebhookHmacAnySecret(rawBody, signWith(rawBody, devSecret), ['', ''])).toBe(false);
  });
});
