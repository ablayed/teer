// APP-03 / Lot 2 — continuation de rattachement embarqué : intégrité, expiration, et non-
// confusion avec le state OAuth legacy dans LES DEUX SENS (règle 4 du mandat).
import { signState, verifyState } from '@/lib/shopify/state';
import { beforeEach, describe, expect, it } from 'vitest';

describe('continuation de rattachement embarqué (embedded_link_intent)', () => {
  beforeEach(() => {
    process.env.SHOPIFY_API_SECRET = 'intent-secret-sentinel';
  });

  it('vérifie un jeton fraîchement signé et restitue exactement son contenu', async () => {
    const { signEmbeddedLinkIntent, verifyEmbeddedLinkIntent } = await import(
      '@/lib/shopify/embedded-link-intent'
    );
    const exp = Date.now() + 10 * 60 * 1000;
    const token = signEmbeddedLinkIntent({
      shopDomain: 'public-shop.myshopify.com',
      clientId: 'public_client_sentinel',
      host: 'aGVsbG8td29ybGQ',
      exp,
    });

    const payload = verifyEmbeddedLinkIntent(token);

    expect(payload).toEqual({
      purpose: 'embedded_link_intent',
      shopDomain: 'public-shop.myshopify.com',
      clientId: 'public_client_sentinel',
      host: 'aGVsbG8td29ybGQ',
      exp,
    });
  });

  it('rejette un jeton expiré', async () => {
    const { signEmbeddedLinkIntent, verifyEmbeddedLinkIntent } = await import(
      '@/lib/shopify/embedded-link-intent'
    );
    const token = signEmbeddedLinkIntent({
      shopDomain: 'public-shop.myshopify.com',
      clientId: 'public_client_sentinel',
      host: 'aGVsbG8td29ybGQ',
      exp: Date.now() - 1,
    });

    expect(verifyEmbeddedLinkIntent(token)).toBeNull();
  });

  it('rejette un jeton dont la signature a été altérée (intégrité)', async () => {
    const { signEmbeddedLinkIntent, verifyEmbeddedLinkIntent } = await import(
      '@/lib/shopify/embedded-link-intent'
    );
    const token = signEmbeddedLinkIntent({
      shopDomain: 'public-shop.myshopify.com',
      clientId: 'public_client_sentinel',
      host: 'aGVsbG8td29ybGQ',
      exp: Date.now() + 60_000,
    });
    const [payload] = token.split('.');
    const tampered = `${payload}.${'0'.repeat(64)}`;

    expect(verifyEmbeddedLinkIntent(tampered)).toBeNull();
  });

  it('rejette un jeton mal formé (segments manquants ou surnuméraires)', async () => {
    const { verifyEmbeddedLinkIntent } = await import('@/lib/shopify/embedded-link-intent');

    expect(verifyEmbeddedLinkIntent('not-a-token')).toBeNull();
    expect(verifyEmbeddedLinkIntent('a.b.c')).toBeNull();
  });

  it('confusion (sens 1) : un state OAuth legacy signé n’est JAMAIS accepté comme continuation embarquée', async () => {
    const { verifyEmbeddedLinkIntent } = await import('@/lib/shopify/embedded-link-intent');
    const oauthState = signState({
      nonce: 'nonce-sentinel',
      merchantAccountId: 'tenant-sentinel',
      shopDomain: 'public-shop.myshopify.com',
      exp: Date.now() + 60_000,
      clientId: 'public_client_sentinel',
    });

    expect(verifyEmbeddedLinkIntent(oauthState)).toBeNull();
  });

  it('confusion (sens 2) : une continuation embarquée n’est JAMAIS acceptée comme state OAuth legacy', async () => {
    const { signEmbeddedLinkIntent } = await import('@/lib/shopify/embedded-link-intent');
    const intent = signEmbeddedLinkIntent({
      shopDomain: 'public-shop.myshopify.com',
      clientId: 'public_client_sentinel',
      host: 'aGVsbG8td29ybGQ',
      exp: Date.now() + 60_000,
    });

    expect(verifyState(intent)).toBeNull();
  });
});
