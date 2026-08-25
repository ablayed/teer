import {
  generateWebhookToken,
  hashWebhookTokenSecret,
  parseWebhookToken,
  verifyWebhookTokenSecret,
} from '@/lib/ingestion/webhook-token';
import { describe, expect, it } from 'vitest';

describe('Lot L3 — generateWebhookToken', () => {
  it('produit un secret jamais dérivable de son empreinte (hash ≠ secret, hash reproductible)', () => {
    const token = generateWebhookToken();
    expect(token.secretHash).not.toBe(token.secret);
    expect(hashWebhookTokenSecret(token.secret)).toBe(token.secretHash);
  });

  it('raw = publicId.secret, parseWebhookToken le retrouve exactement', () => {
    const token = generateWebhookToken();
    expect(token.raw).toBe(`${token.publicId}.${token.secret}`);
    expect(parseWebhookToken(token.raw)).toEqual({
      publicId: token.publicId,
      secret: token.secret,
    });
  });

  it('deux générations successives ne partagent jamais publicId ni secret', () => {
    const a = generateWebhookToken();
    const b = generateWebhookToken();
    expect(a.publicId).not.toBe(b.publicId);
    expect(a.secret).not.toBe(b.secret);
  });
});

describe('Lot L3 — parseWebhookToken', () => {
  it.each([
    ['sans séparateur', 'onlyoneparttoken'],
    ['séparateur en tête', '.secretonly'],
    ['séparateur en fin', 'publiconly.'],
    ['chaîne vide', ''],
  ])('%s → null', (_label, raw) => {
    expect(parseWebhookToken(raw)).toBeNull();
  });

  it('un point supplémentaire dans le secret reste dans le secret (un seul split, sur le premier point)', () => {
    expect(parseWebhookToken('pub.sec.ret')).toEqual({ publicId: 'pub', secret: 'sec.ret' });
  });
});

describe('Lot L3 — verifyWebhookTokenSecret', () => {
  it('contrôle positif : le secret généré vérifie contre sa propre empreinte', () => {
    const token = generateWebhookToken();
    expect(verifyWebhookTokenSecret(token.secret, token.secretHash)).toBe(true);
  });

  it('preuve #4 (mauvais secret) : un secret différent ne vérifie jamais', () => {
    const token = generateWebhookToken();
    const other = generateWebhookToken();
    expect(verifyWebhookTokenSecret(other.secret, token.secretHash)).toBe(false);
  });

  it('empreinte corrompue (longueur différente) → false, jamais une exception', () => {
    const token = generateWebhookToken();
    expect(verifyWebhookTokenSecret(token.secret, 'deadbeef')).toBe(false);
  });

  it('empreinte non-hex → false, jamais une exception', () => {
    const token = generateWebhookToken();
    expect(verifyWebhookTokenSecret(token.secret, 'not-hex-at-all!!')).toBe(false);
  });
});

// Preuve #6 (comparaison à temps constant) : verifyWebhookTokenSecret passe systématiquement par
// node:crypto timingSafeEqual sur les deux empreintes SHA-256 (32 octets chacune, longueur fixe
// indépendante du contenu du secret) — jamais un `===` sur des chaînes, jamais un retour anticipé
// une fois les octets décodés. Le seul court-circuit avant timingSafeEqual porte sur la LONGUEUR
// des tampons (garde requise par l'API node:crypto elle-même, qui lève sur des tailles différentes,
// pas un raccourci de sécurité) — vérifié par lecture de lib/ingestion/webhook-token.ts, pas ici :
// un test temporel sur un algorithme déjà connu pour être constant-time (timingSafeEqual) mesurerait
// du bruit, pas une propriété.
