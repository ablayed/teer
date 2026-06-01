import { createHash, randomBytes } from 'node:crypto';

export function generateInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashInvitationToken(token: string): string {
  return `\\x${createHash('sha256').update(token).digest('hex')}`;
}
