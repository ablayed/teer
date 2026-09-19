/**
 * Contrat du rappel de récupération de mot de passe (lot PWD-RESET-01).
 *
 * Deux propriétés, et ce sont les seules qui portent la sécurité de ce parcours
 * côté application :
 *
 *  1. **La destination est FIXE, écrite ici, jamais fournie par la requête.**
 *     Un lien de récupération arrive par courriel : accepter un `next`/`redirectTo`
 *     sur ce chemin en ferait une redirection ouverte exploitable par courriel.
 *     Les constantes ci-dessous sont les seules destinations possibles du rappel
 *     quand la session échangée est une session de récupération.
 *
 *  2. **La nature « récupération » est lue dans le JETON, jamais dans l'URL.**
 *     Mesuré le 2026-09-19 sur la pile locale : une session ouverte par un lien de
 *     récupération porte `amr: [{ method: 'recovery' }]`, là où une connexion par
 *     mot de passe porte `method: 'password'`. Le discriminant vit donc dans un
 *     jeton signé par GoTrue et reçu de notre propre échange — rien dans la requête
 *     ne peut le déplacer. C'est strictement plus fort qu'un marqueur en query
 *     string, et cela évite d'avoir à faire autoriser une nouvelle URL de
 *     redirection côté Supabase (la production n'autorise que `/auth/callback`).
 *
 * Module pur (aucun import de `env`, de client Supabase ou de `'use server'`) pour
 * rester unitairement testable — cf. la note `lib/env.ts` du CLAUDE.md.
 */

/** Écran de demande d'un lien de réinitialisation. */
export const PASSWORD_RESET_REQUEST_PATH = '/mot-de-passe-oublie';

/**
 * Écran de saisie du nouveau mot de passe. Destination UNIQUE du rappel pour une
 * session de récupération — aucun paramètre de requête ne peut la remplacer.
 */
export const PASSWORD_RESET_NEW_PASSWORD_PATH = '/mot-de-passe-oublie/nouveau';

/**
 * Lien invalide, expiré ou déjà utilisé. Les trois cas sont INDISTINGUABLES :
 * mesuré le 2026-09-19, GoTrue rend exactement `error=access_denied` +
 * `error_code=otp_expired` pour un jeton expiré, rejoué ou inexistant. Une seule
 * destination, donc, et un seul message honnête.
 */
export const PASSWORD_RESET_INVALID_LINK_PATH = '/connexion?reason=lien_invalide';

type AccessTokenClaims = {
  amr?: Array<{ method?: string } | null> | null;
};

/**
 * Vrai si le jeton d'accès a été obtenu par un lien de récupération.
 *
 * On lit une revendication d'un jeton que GoTrue vient de nous remettre au terme de
 * notre propre échange : la signature a déjà été établie en amont, cette fonction ne
 * fait que lire. Elle n'authentifie rien et ne doit jamais servir à cela.
 *
 * Volontairement STRICTE sur `recovery` : le courriel par défaut porte aussi un code
 * à six chiffres dont la vérification produit `method: 'otp'`, mais ce lot n'offre
 * pas ce chemin — l'élargir ouvrirait une porte qu'aucun écran n'emprunte.
 */
export function isRecoveryAccessToken(accessToken: string | null | undefined): boolean {
  if (!accessToken) {
    return false;
  }

  const payload = accessToken.split('.')[1];
  if (!payload) {
    return false;
  }

  try {
    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as AccessTokenClaims | null;

    return Boolean(claims?.amr?.some((entry) => entry?.method === 'recovery'));
  } catch {
    return false;
  }
}
