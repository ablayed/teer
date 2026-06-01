import { type InvitationAcceptanceState, acceptInvitationState } from '@/lib/team/invitation-state';
import { describe, expect, it } from 'vitest';

function pendingInvitation(overrides: Partial<InvitationAcceptanceState> = {}) {
  return {
    acceptedAt: null,
    acceptedBy: null,
    email: 'aida@example.com',
    expiresAt: '2026-06-08T00:00:00.000Z',
    status: 'pending' as const,
    ...overrides,
  };
}

describe('cycle invitation', () => {
  it('passe de pending à accepted', () => {
    const result = acceptInvitationState({
      alreadyMember: false,
      invitation: pendingInvitation(),
      now: new Date('2026-06-01T00:00:00.000Z'),
      userEmail: 'aida@example.com',
      userId: 'user-1',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.status).toBe('accepted');
      expect(result.state.acceptedBy).toBe('user-1');
    }
  });

  it('rejette un token réutilisé', () => {
    const result = acceptInvitationState({
      alreadyMember: true,
      invitation: pendingInvitation({ status: 'accepted' }),
      now: new Date('2026-06-01T00:00:00.000Z'),
      userEmail: 'aida@example.com',
      userId: 'user-1',
    });

    expect(result).toEqual({ ok: false, errorCode: 'invalid' });
  });

  it('rejette une invitation expirée', () => {
    const result = acceptInvitationState({
      alreadyMember: false,
      invitation: pendingInvitation(),
      now: new Date('2026-06-09T00:00:00.000Z'),
      userEmail: 'aida@example.com',
      userId: 'user-1',
    });

    expect(result).toEqual({ ok: false, errorCode: 'expired' });
  });

  it('rejette un e-mail non concordant', () => {
    const result = acceptInvitationState({
      alreadyMember: false,
      invitation: pendingInvitation(),
      now: new Date('2026-06-01T00:00:00.000Z'),
      userEmail: 'autre@example.com',
      userId: 'user-1',
    });

    expect(result).toEqual({ ok: false, errorCode: 'email_mismatch' });
  });
});
