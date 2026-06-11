import { afterEach, describe, expect, it, vi } from 'vitest';

const captureMessage = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureMessage: (...args: unknown[]) => captureMessage(...args),
}));

import { reportAuthorizationFailure } from '@/lib/security/authz-audit';

afterEach(() => captureMessage.mockClear());

describe('reportAuthorizationFailure (OWASP A09)', () => {
  it('capture un événement Sentry « warning » taggé authorization_failure', () => {
    reportAuthorizationFailure({
      actionName: 'createPurchaseLot',
      section: 'purchases',
      userId: 'user-1',
      merchantAccountId: 'tenant-1',
      expectedRoles: ['owner'],
      actualRole: 'agent',
    });

    expect(captureMessage).toHaveBeenCalledTimes(1);
    const [message, options] = captureMessage.mock.calls[0] as [string, Record<string, never>];
    expect(message).toContain('FORBIDDEN');
    const opts = options as unknown as {
      level: string;
      tags: Record<string, string>;
      extra: Record<string, unknown>;
    };
    expect(opts.level).toBe('warning');
    expect(opts.tags.security_event).toBe('authorization_failure');
    expect(opts.tags.action).toBe('createPurchaseLot');
    expect(opts.tags.section).toBe('purchases');
    expect(opts.extra.expectedRoles).toEqual(['owner']);
    expect(opts.extra.actualRole).toBe('agent');
    expect(opts.extra.merchantAccountId).toBe('tenant-1');
  });

  it('tolère un non-membre (actualRole null) et des métadonnées absentes', () => {
    reportAuthorizationFailure({
      userId: 'user-2',
      expectedRoles: ['owner', 'manager'],
      actualRole: null,
    });

    const [, options] = captureMessage.mock.calls[0] as [string, Record<string, never>];
    const opts = options as unknown as {
      tags: Record<string, string>;
      extra: Record<string, unknown>;
    };
    expect(opts.tags.action).toBe('unknown');
    expect(opts.tags.section).toBe('unknown');
    expect(opts.extra.actualRole).toBeNull();
    expect(opts.extra.merchantAccountId).toBeNull();
  });
});
