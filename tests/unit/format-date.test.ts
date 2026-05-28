import { formatDateRelative } from '@/lib/format/date';
import { describe, expect, it, vi } from 'vitest';

describe('formatDateRelative', () => {
  it('formats recent hours', () => {
    vi.setSystemTime(new Date('2026-05-28T12:00:00Z'));
    expect(formatDateRelative(new Date('2026-05-28T10:00:00Z'))).toBe('il y a 2 h');
    vi.useRealTimers();
  });

  it('formats yesterday', () => {
    vi.setSystemTime(new Date('2026-05-28T12:00:00Z'));
    expect(formatDateRelative(new Date('2026-05-27T12:00:00Z'))).toBe('hier');
    vi.useRealTimers();
  });

  it('formats days under a week', () => {
    vi.setSystemTime(new Date('2026-05-28T12:00:00Z'));
    expect(formatDateRelative(new Date('2026-05-25T12:00:00Z'))).toBe('il y a 3 j');
    vi.useRealTimers();
  });

  it('formats older dates as absolute dates', () => {
    vi.setSystemTime(new Date('2026-05-28T12:00:00Z'));
    expect(formatDateRelative(new Date('2026-05-10T12:00:00Z'))).toBe('10 mai 2026');
    vi.useRealTimers();
  });
});
