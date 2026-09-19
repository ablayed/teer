import {
  PASSWORD_RESET_INVALID_LINK_PATH,
  PASSWORD_RESET_NEW_PASSWORD_PATH,
  PASSWORD_RESET_REQUEST_PATH,
  isRecoveryAccessToken,
} from '@/lib/security/password-recovery';
import { describe, expect, it } from 'vitest';

/**
 * Jeton d'accès factice portant les revendications voulues. On ne signe rien : la
 * fonction testée LIT une revendication d'un jeton déjà validé en amont, elle
 * n'authentifie pas. La forme (trois segments séparés par des points, charge utile
 * en base64url) est celle mesurée sur la pile locale le 2026-09-19.
 */
function accessTokenWith(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `header.${payload}.signature`;
}

describe('isRecoveryAccessToken', () => {
  it('reconnaît une session ouverte par un lien de récupération', () => {
    // Forme exacte mesurée après exchangeCodeForSession sur un lien de récupération.
    const token = accessTokenWith({
      amr: [{ method: 'recovery', timestamp: 1789820810 }],
      role: 'authenticated',
    });

    expect(isRecoveryAccessToken(token)).toBe(true);
  });

  it("refuse une connexion ordinaire par mot de passe — c'est le cas qui distingue", () => {
    // Même utilisateur, même rôle : seul `amr.method` change.
    const token = accessTokenWith({
      amr: [{ method: 'password', timestamp: 1789820809 }],
      role: 'authenticated',
    });

    expect(isRecoveryAccessToken(token)).toBe(false);
  });

  it("refuse une vérification par code à six chiffres (`otp`), chemin que ce lot n'offre pas", () => {
    const token = accessTokenWith({ amr: [{ method: 'otp', timestamp: 1789820879 }] });

    expect(isRecoveryAccessToken(token)).toBe(false);
  });

  it('reconnaît la récupération même accompagnée d’une autre méthode', () => {
    const token = accessTokenWith({
      amr: [{ method: 'password' }, { method: 'recovery' }],
    });

    expect(isRecoveryAccessToken(token)).toBe(true);
  });

  it('refuse sans lever sur une entrée absente, vide, malformée ou non décodable', () => {
    expect(isRecoveryAccessToken(null)).toBe(false);
    expect(isRecoveryAccessToken(undefined)).toBe(false);
    expect(isRecoveryAccessToken('')).toBe(false);
    expect(isRecoveryAccessToken('pas-un-jeton')).toBe(false);
    expect(isRecoveryAccessToken('header..signature')).toBe(false);
    expect(isRecoveryAccessToken('header.%%%.signature')).toBe(false);
    expect(isRecoveryAccessToken(accessTokenWith({}))).toBe(false);
    expect(isRecoveryAccessToken(accessTokenWith({ amr: null }))).toBe(false);
    expect(isRecoveryAccessToken(accessTokenWith({ amr: 'recovery' }))).toBe(false);
    expect(isRecoveryAccessToken(accessTokenWith({ amr: [null] }))).toBe(false);
  });

  it('ne se laisse pas duper par le mot « recovery » ailleurs que dans `amr.method`', () => {
    // Un attaquant ne contrôle pas ce jeton, mais la garde doit rester littérale :
    // c'est `amr[].method` qui décide, pas une occurrence de la chaîne.
    const token = accessTokenWith({
      email: 'recovery@example.com',
      user_metadata: { note: 'recovery' },
      amr: [{ method: 'password' }],
    });

    expect(isRecoveryAccessToken(token)).toBe(false);
  });
});

describe('destinations du rappel de récupération', () => {
  it('sont des chemins internes fixes, écrits dans le code', () => {
    for (const path of [
      PASSWORD_RESET_REQUEST_PATH,
      PASSWORD_RESET_NEW_PASSWORD_PATH,
      PASSWORD_RESET_INVALID_LINK_PATH,
    ]) {
      expect(path.startsWith('/')).toBe(true);
      expect(path.startsWith('//')).toBe(false);
      expect(path).not.toContain(String.fromCharCode(92));
    }
  });

  it("l'écran de nouveau mot de passe et l'écran de demande sont distincts", () => {
    expect(PASSWORD_RESET_NEW_PASSWORD_PATH).not.toBe(PASSWORD_RESET_REQUEST_PATH);
    expect(PASSWORD_RESET_NEW_PASSWORD_PATH).toBe('/mot-de-passe-oublie/nouveau');
  });
});
