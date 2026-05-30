import { decryptToken, encryptToken, getEncryptionKey } from '@/lib/shopify/crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const validKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const originalKey = process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY;

function unsetEncryptionKey() {
  Reflect.deleteProperty(process.env, 'SHOPIFY_TOKEN_ENCRYPTION_KEY');
}

beforeEach(() => {
  process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = validKey;
});

afterEach(() => {
  if (originalKey === undefined) {
    unsetEncryptionKey();
    return;
  }

  process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = originalKey;
});

describe('Shopify token crypto', () => {
  it('decrypts an encrypted token back to the original plaintext', () => {
    const plaintext = 'shpat_test_access_token';
    const encrypted = encryptToken(plaintext);

    expect(decryptToken(encrypted)).toBe(plaintext);
  });

  it('uses a random IV so the same plaintext encrypts differently', () => {
    const plaintext = 'shpat_same_plaintext';

    expect(encryptToken(plaintext)).not.toBe(encryptToken(plaintext));
  });

  it('throws when decrypting a malformed token', () => {
    expect(() => decryptToken('not-a-valid-token')).toThrow(
      'decryptToken: invalid encrypted token format',
    );
  });

  it('throws when the auth tag has been altered', () => {
    const encrypted = encryptToken('shpat_sensitive_token');
    const [iv, authTag, ciphertext] = encrypted.split(':');
    const alteredAuthTag = `${authTag.startsWith('0') ? '1' : '0'}${authTag.slice(1)}`;

    expect(() => decryptToken([iv, alteredAuthTag, ciphertext].join(':'))).toThrow(
      'decryptToken: authentication failed or token is corrupted',
    );
  });

  it('throws when the encryption key is absent', () => {
    unsetEncryptionKey();

    expect(() => getEncryptionKey()).toThrow(
      'SHOPIFY_TOKEN_ENCRYPTION_KEY is required to encrypt Shopify tokens',
    );
  });

  it('throws when the encryption key has the wrong length', () => {
    process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = 'abc123';

    expect(() => getEncryptionKey()).toThrow(
      'SHOPIFY_TOKEN_ENCRYPTION_KEY must be 64 hex characters',
    );
  });
});
