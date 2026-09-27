import { encryptToken } from '@/lib/shopify/crypto';
import { hasUsableCredentialsForApp } from '@/lib/shopify/non-embedded-credentials';
import {
  signShopifyNonEmbeddedInstallIntent,
  verifyShopifyNonEmbeddedInstallIntent,
} from '@/lib/shopify/non-embedded-install-intent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const encryptionKey = Buffer.from('non-embedded-install-test-key')
  .toString('hex')
  .padEnd(64, '0')
  .slice(0, 64);
const clientId = 'public-client-sentinel';
let originalEncryptionKey: string | undefined;

beforeEach(() => {
  originalEncryptionKey = process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY;
  process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = encryptionKey;
});

afterEach(() => {
  if (originalEncryptionKey === undefined) {
    Reflect.deleteProperty(process.env, 'SHOPIFY_TOKEN_ENCRYPTION_KEY');
  } else {
    process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = originalEncryptionKey;
  }
});

function shopRecord(overrides: Partial<Parameters<typeof hasUsableCredentialsForApp>[0]> = {}) {
  return {
    shopifyClientId: clientId,
    status: 'active',
    storeKind: 'shopify',
    accessTokenEncrypted: encryptToken('usable-access-token'),
    accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    refreshTokenEncrypted: null,
    refreshTokenExpiresAt: null,
    ...overrides,
  };
}

describe('Shopify non-embedded install intent and credential gate', () => {
  it('signs only the canonical app label and validated shop into a short-lived intent', () => {
    const now = Date.now();
    const token = signShopifyNonEmbeddedInstallIntent(
      { appLabel: 'teer-public', shop: 'public-shop.myshopify.com' },
      'public-app-secret',
      now,
    );

    expect(verifyShopifyNonEmbeddedInstallIntent(token, 'public-app-secret', now)).toMatchObject({
      appLabel: 'teer-public',
      shop: 'public-shop.myshopify.com',
    });
    expect(verifyShopifyNonEmbeddedInstallIntent(token, 'other-app-secret', now)).toBeNull();
    expect(
      verifyShopifyNonEmbeddedInstallIntent(token, 'public-app-secret', now + 5 * 60_000 + 1),
    ).toBeNull();
    expect(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString()).not.toContain('host');
    expect(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString()).not.toContain('hmac');
  });

  it('accepts only a connected shop with the expected app and decryptable usable credentials', () => {
    expect(hasUsableCredentialsForApp(shopRecord(), clientId)).toBe(true);
    expect(
      hasUsableCredentialsForApp(shopRecord({ shopifyClientId: 'other-client' }), clientId),
    ).toBe(false);
    expect(hasUsableCredentialsForApp(shopRecord({ status: 'uninstalled' }), clientId)).toBe(false);
    expect(hasUsableCredentialsForApp(shopRecord({ accessTokenEncrypted: null }), clientId)).toBe(
      false,
    );
    expect(
      hasUsableCredentialsForApp(shopRecord({ accessTokenEncrypted: 'not-encrypted' }), clientId),
    ).toBe(false);
  });

  it('requires a decryptable unexpired refresh credential when the access credential expired', () => {
    const expired = new Date(Date.now() - 1_000).toISOString();
    expect(
      hasUsableCredentialsForApp(
        shopRecord({
          accessTokenExpiresAt: expired,
          refreshTokenEncrypted: encryptToken('usable-refresh-token'),
          refreshTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        clientId,
      ),
    ).toBe(true);
    expect(
      hasUsableCredentialsForApp(shopRecord({ accessTokenExpiresAt: expired }), clientId),
    ).toBe(false);
    expect(
      hasUsableCredentialsForApp(
        shopRecord({ accessTokenExpiresAt: expired, refreshTokenEncrypted: 'not-encrypted' }),
        clientId,
      ),
    ).toBe(false);
  });
});
