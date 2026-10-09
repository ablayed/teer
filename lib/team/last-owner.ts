// Garde du dernier owner (migration 0162).
//
// La garde vit en base : le trigger `merchant_member_last_owner_guard` verrouille la ligne du
// compte puis lève `last_owner` (23514) quand un retrait ou une rétrogradation laisserait le
// compte sans owner. Le décompte fait par l'action serveur avant l'écriture ne sert qu'à
// répondre tôt ; deux retraits concurrents le franchissent tous les deux.
//
// Module pur : ni `env`, ni client Supabase, ni `'use server'`.

export const LAST_OWNER_SQLSTATE = '23514';
export const LAST_OWNER_MESSAGE = 'last_owner';

type DatabaseErrorLike = { code?: string | null; message?: string | null } | null | undefined;

/**
 * Vrai si l'erreur PostgREST est le refus du trigger du dernier owner. Le code seul ne suffit
 * pas : 23514 est aussi celui de toute contrainte CHECK.
 */
export function isLastOwnerViolation(error: DatabaseErrorLike): boolean {
  return error?.code === LAST_OWNER_SQLSTATE && error.message === LAST_OWNER_MESSAGE;
}

export type TeamErrorMessageKey = 'errors.generic' | 'errors.last_owner';

/** Clé de message (`settings.team`) pour un refus d'action d'équipe. */
export function teamErrorMessageKey(errorCode: string | null | undefined): TeamErrorMessageKey {
  return errorCode === 'last_owner' ? 'errors.last_owner' : 'errors.generic';
}
