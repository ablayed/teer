import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  env: {
    CONNECTOR_CREDENTIALS_ENCRYPTION_KEY: '01'.repeat(32),
    CONNECTOR_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS: undefined as string | undefined,
  },
}));

vi.mock('@/lib/env', () => ({ env: harness.env }));

const plaintext = 'cs_synthetic_secret_value';

describe('chiffrement des credentials connecteur', () => {
  beforeEach(() => {
    harness.env.CONNECTOR_CREDENTIALS_ENCRYPTION_KEY = '01'.repeat(32);
    harness.env.CONNECTOR_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS = undefined;
  });

  it('déchiffre une valeur produite avec la clé courante', async () => {
    const { decryptConnectorCredential, encryptConnectorCredential } = await import(
      '@/lib/connector-credentials/crypto'
    );
    const encrypted = encryptConnectorCredential(plaintext);

    expect(decryptConnectorCredential(encrypted)).toBe(plaintext);
  });

  it('déchiffre une valeur produite avec la clé précédente pendant une rotation', async () => {
    const { decryptConnectorCredential, encryptConnectorCredential } = await import(
      '@/lib/connector-credentials/crypto'
    );
    harness.env.CONNECTOR_CREDENTIALS_ENCRYPTION_KEY = '02'.repeat(32);
    const encryptedWithPrevious = encryptConnectorCredential(plaintext);
    harness.env.CONNECTOR_CREDENTIALS_ENCRYPTION_KEY = '01'.repeat(32);
    harness.env.CONNECTOR_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS = '02'.repeat(32);

    expect(decryptConnectorCredential(encryptedWithPrevious)).toBe(plaintext);
  });

  it('refuse une valeur chiffrée avec une clé inconnue sans révéler le secret', async () => {
    const { decryptConnectorCredential, encryptConnectorCredential } = await import(
      '@/lib/connector-credentials/crypto'
    );
    harness.env.CONNECTOR_CREDENTIALS_ENCRYPTION_KEY = '03'.repeat(32);
    const encryptedWithUnknownKey = encryptConnectorCredential(plaintext);
    harness.env.CONNECTOR_CREDENTIALS_ENCRYPTION_KEY = '01'.repeat(32);

    expect(() => decryptConnectorCredential(encryptedWithUnknownKey)).toThrow();
    try {
      decryptConnectorCredential(encryptedWithUnknownKey);
    } catch (error) {
      expect(String(error)).not.toContain(plaintext);
      expect(String(error)).not.toContain('03'.repeat(32));
    }
  });
});
