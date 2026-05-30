import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_KEY_HEX_LENGTH = 64;
const IV_BYTE_LENGTH = 12;
const AUTH_TAG_BYTE_LENGTH = 16;

function isHex(value: string): boolean {
  return /^[0-9a-f]+$/i.test(value);
}

function isEvenLength(value: string): boolean {
  return value.length % 2 === 0;
}

export function getEncryptionKey(): Buffer {
  const key = process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY;

  if (!key) {
    throw new Error('SHOPIFY_TOKEN_ENCRYPTION_KEY is required to encrypt Shopify tokens');
  }

  if (key.length !== ENCRYPTION_KEY_HEX_LENGTH || !isHex(key)) {
    throw new Error('SHOPIFY_TOKEN_ENCRYPTION_KEY must be 64 hex characters');
  }

  return Buffer.from(key, 'hex');
}

export function encryptToken(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_BYTE_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv.toString('hex'), authTag.toString('hex'), ciphertext.toString('hex')].join(':');
}

export function decryptToken(encrypted: string): string {
  const parts = encrypted.split(':');

  if (parts.length !== 3) {
    throw new Error('decryptToken: invalid encrypted token format');
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;

  if (
    !ivHex ||
    !authTagHex ||
    ivHex.length !== IV_BYTE_LENGTH * 2 ||
    authTagHex.length !== AUTH_TAG_BYTE_LENGTH * 2 ||
    !isHex(ivHex) ||
    !isHex(authTagHex) ||
    (ciphertextHex !== '' && (!isHex(ciphertextHex) || !isEvenLength(ciphertextHex)))
  ) {
    throw new Error('decryptToken: invalid encrypted token format');
  }

  try {
    const key = getEncryptionKey();
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextHex, 'hex')),
      decipher.final(),
    ]);

    return plaintext.toString('utf8');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('SHOPIFY_TOKEN_ENCRYPTION_KEY')) {
      throw error;
    }

    throw new Error('decryptToken: authentication failed or token is corrupted');
  }
}
