import { generateInvitationToken, hashInvitationToken } from '@/lib/team/invitation-token';
import { describe, expect, it } from 'vitest';

describe('token invitation', () => {
  it('génère un token clair long et ne stocke que son hash', () => {
    const token = generateInvitationToken();
    const hash = hashInvitationToken(token);

    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(hash).not.toContain(token);
    expect(hash).not.toBe(token);
    expect(hash).toMatch(/^\\x[0-9a-f]{64}$/);
  });
});
