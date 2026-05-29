import {
  formatDateAbsolute,
  formatDateRelative,
  formatDateTime,
  formatMonthYear,
} from '@/lib/format/date';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('date formatters', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-21T14:32:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('formatDateRelative', () => {
    it('formats dates under one minute as now', () => {
      expect(formatDateRelative(new Date('2026-04-21T14:31:30Z'))).toBe("à l'instant");
    });

    it('formats recent minutes', () => {
      expect(formatDateRelative('2026-04-21T14:27:00Z')).toBe('il y a 5 min');
    });

    it('formats recent hours', () => {
      expect(formatDateRelative(new Date('2026-04-21T12:32:00Z'))).toBe('il y a 2 h');
    });

    it('formats yesterday', () => {
      expect(formatDateRelative(new Date('2026-04-20T14:32:00Z'))).toBe('hier');
    });

    it('formats days under a week', () => {
      expect(formatDateRelative(new Date('2026-04-18T14:32:00Z'))).toBe('il y a 3 j');
    });

    it('formats dates older than seven days as absolute dates', () => {
      expect(formatDateRelative(new Date('2026-04-10T14:32:00Z'))).toBe('10 avril 2026');
    });

    it('throws on invalid relative input', () => {
      expect(() => formatDateRelative('not-a-date')).toThrow(
        new RangeError('formatDate: invalid date'),
      );
    });
  });

  it('formats absolute dates', () => {
    expect(formatDateAbsolute('2026-04-21T14:32:00Z')).toBe('21 avril 2026');
  });

  it('formats date and time', () => {
    expect(formatDateTime('2026-04-21T14:32:00Z')).toBe('21 avril 2026 à 14:32');
  });

  it('formats month and year', () => {
    expect(formatMonthYear(new Date('2026-04-21T14:32:00Z'))).toBe('avril 2026');
  });

  it('throws on invalid absolute input', () => {
    expect(() => formatDateAbsolute(new Date('not-a-date'))).toThrow(
      new RangeError('formatDate: invalid date'),
    );
  });
});
