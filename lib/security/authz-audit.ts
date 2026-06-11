import * as Sentry from '@sentry/nextjs';

// OWASP A09 — journalisation des échecs de CONTRÔLE D'ACCÈS au point central
// (lib/actions/safe-action.ts, garde `requireRole`).
//
// Pourquoi Sentry et pas `audit_log` : le schéma d'`audit_log` est taillé pour les
// transitions de commande (prior_state / next_state / source / reason, rattaché à un
// `order`). Un refus d'accès hors-commande n'a pas de forme qui s'y projette ;
// l'y forcer inventerait un usage et buterait sur les contraintes NOT NULL. La Phase 9
// interdisant toute migration, on capture un événement Sentry structuré (recherchable
// par tag `security_event:authorization_failure`).
//
// On ne journalise QUE les FORBIDDEN (utilisateur authentifié tentant une action
// au-dessus de son rôle — signal de tentative d'élévation de privilège). Les
// UNAUTHENTICATED sont volontairement exclus : routiniers (sessions expirées,
// visiteurs déconnectés) et donc bruyants/peu informatifs.
type AuthorizationFailure = {
  actionName?: string;
  section?: string;
  userId: string;
  merchantAccountId?: string;
  expectedRoles: readonly string[];
  /** Rôle effectif de l'utilisateur, ou null s'il n'est pas membre du tenant. */
  actualRole?: string | null;
};

export function reportAuthorizationFailure(failure: AuthorizationFailure): void {
  Sentry.captureMessage('Authorization failure: FORBIDDEN', {
    level: 'warning',
    tags: {
      security_event: 'authorization_failure',
      action: failure.actionName ?? 'unknown',
      section: failure.section ?? 'unknown',
    },
    extra: {
      userId: failure.userId,
      merchantAccountId: failure.merchantAccountId ?? null,
      expectedRoles: [...failure.expectedRoles],
      actualRole: failure.actualRole ?? null,
    },
  });
}
