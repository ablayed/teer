export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export type InvitationAcceptanceState = {
  acceptedAt: string | null;
  acceptedBy: string | null;
  email: string;
  expiresAt: string;
  status: InvitationStatus;
};

export type InvitationAcceptanceResult =
  | { alreadyMember: boolean; ok: true; state: InvitationAcceptanceState }
  | { ok: false; errorCode: 'email_mismatch' | 'expired' | 'invalid' };

export function acceptInvitationState({
  alreadyMember,
  invitation,
  now,
  userEmail,
  userId,
}: {
  alreadyMember: boolean;
  invitation: InvitationAcceptanceState;
  now: Date;
  userEmail: string;
  userId: string;
}): InvitationAcceptanceResult {
  if (invitation.status !== 'pending') {
    return { ok: false, errorCode: invitation.status === 'expired' ? 'expired' : 'invalid' };
  }

  if (new Date(invitation.expiresAt).getTime() <= now.getTime()) {
    return { ok: false, errorCode: 'expired' };
  }

  if (invitation.email.toLowerCase() !== userEmail.toLowerCase()) {
    return { ok: false, errorCode: 'email_mismatch' };
  }

  return {
    alreadyMember,
    ok: true,
    state: {
      ...invitation,
      acceptedAt: now.toISOString(),
      acceptedBy: userId,
      status: 'accepted',
    },
  };
}
