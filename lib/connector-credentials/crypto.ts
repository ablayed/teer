import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '@/lib/env';

const ALGORITHM = 'aes-256-gcm';
const KEY_HEX_LENGTH = 64;
const IV_BYTE_LENGTH = 12;
const AUTH_TAG_BYTE_LENGTH = 16;

function isHex(value: string): boolean {
  return /^[0-9a-f]+$/i.test(value);
}

function getKey(value: string | undefined, name: string): Buffer | null {
  if (!value) return null;
  if (value.length !== KEY_HEX_LENGTH || !isHex(value)) {
    throw new Error(`${name} must be 64 hex characters`);
  }
  return Buffer.from(value, 'hex');
}

function activeKey(): Buffer {
  const key = getKey(
    env.CONNECTOR_CREDENTIALS_ENCRYPTION_KEY,
    'CONNECTOR_CREDENTIALS_ENCRYPTION_KEY',
  );
  if (!key) {
    throw new Error('CONNECTOR_CREDENTIALS_ENCRYPTION_KEY is required');
  }
  return key;
}

/** Chiffre une credential fournisseur sans exposer sa valeur dans les erreurs. */
export function encryptConnectorCredential(plaintext: string): string {
  const iv = randomBytes(IV_BYTE_LENGTH);
  const cipher = createCipheriv(ALGORITHM, activeKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), ciphertext.toString('hex')].join(
    ':',
  );
}

function isEvenLength(value: string): boolean {
  return value.length % 2 === 0;
}

/** Déchiffre avec la clé courante puis l'ancienne pendant une rotation contrôlée. */
export function decryptConnectorCredential(encrypted: string): string {
  const parts = encrypted.split(':');
  if (parts.length !== 3) throw new Error('invalid encrypted credential format');
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
    throw new Error('invalid encrypted credential format');
  }

  const keys = [activeKey()];
  const previous = getKey(
    env.CONNECTOR_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS,
    'CONNECTOR_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS',
  );
  if (previous) keys.push(previous);

  for (const key of keys) {
    try {
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextHex, 'hex')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // La rotation essaie la clé précédente sans exposer de détail cryptographique.
    }
  }

  throw new Error('credential authentication failed');
}
