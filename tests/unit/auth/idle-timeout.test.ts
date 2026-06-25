import { getCountdown, isExpired, isWarning } from '@/lib/auth/idle-utils';
import { describe, expect, it } from 'vitest';

const TIMEOUT_MS = 10_000;
const WARNING_MS = 3_000;

describe('isWarning', () => {
  it('returns false when elapsed < timeout - warning', () => {
    const last = 0;
    const now = 6_000;
    expect(isWarning(last, now, TIMEOUT_MS, WARNING_MS)).toBe(false);
  });

  it('returns true when elapsed equals timeout - warning', () => {
    const last = 0;
    const now = TIMEOUT_MS - WARNING_MS;
    expect(isWarning(last, now, TIMEOUT_MS, WARNING_MS)).toBe(true);
  });

  it('returns true just before expiry', () => {
    const last = 0;
    const now = TIMEOUT_MS - 1;
    expect(isWarning(last, now, TIMEOUT_MS, WARNING_MS)).toBe(true);
  });

  it('returns false when already expired', () => {
    const last = 0;
    const now = TIMEOUT_MS;
    expect(isWarning(last, now, TIMEOUT_MS, WARNING_MS)).toBe(false);
  });
});

describe('isExpired', () => {
  it('returns false when elapsed < timeout', () => {
    expect(isExpired(0, TIMEOUT_MS - 1, TIMEOUT_MS)).toBe(false);
  });

  it('returns true when elapsed equals timeout', () => {
    expect(isExpired(0, TIMEOUT_MS, TIMEOUT_MS)).toBe(true);
  });

  it('returns true when elapsed exceeds timeout', () => {
    expect(isExpired(0, TIMEOUT_MS + 5_000, TIMEOUT_MS)).toBe(true);
  });
});

describe('getCountdown', () => {
  it('returns full countdown at start', () => {
    expect(getCountdown(0, 0, TIMEOUT_MS)).toBe(TIMEOUT_MS / 1000);
  });

  it('returns remaining seconds correctly', () => {
    expect(getCountdown(0, TIMEOUT_MS - 3_000, TIMEOUT_MS)).toBe(3);
  });

  it('returns 0 when expired', () => {
    expect(getCountdown(0, TIMEOUT_MS + 1_000, TIMEOUT_MS)).toBe(0);
  });

  it('rounds up sub-second remainders', () => {
    expect(getCountdown(0, TIMEOUT_MS - 2_500, TIMEOUT_MS)).toBe(3);
  });
});
