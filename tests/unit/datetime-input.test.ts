import {
  dateTimeInputsToIso,
  isoToDateTimeInputs,
  nextWholeHourInputs,
  normalizeHourInput,
} from '@/lib/format/datetime-input';
import { describe, expect, it, vi } from 'vitest';

describe('datetime input helpers', () => {
  it('normalizes any valid time input to the hour only', () => {
    expect(normalizeHourInput('15:56')).toBe('15:00');
    expect(normalizeHourInput('09:00')).toBe('09:00');
    expect(normalizeHourInput('24:00')).toBe('');
  });

  it('prefills the next whole hour when the current time has minutes', () => {
    expect(nextWholeHourInputs(new Date(2026, 5, 23, 15, 56))).toEqual({
      date: '2026-06-23',
      time: '16:00',
    });
    expect(nextWholeHourInputs(new Date(2026, 5, 23, 12, 45))).toEqual({
      date: '2026-06-23',
      time: '13:00',
    });
  });

  it('keeps the current hour when already on the hour', () => {
    expect(nextWholeHourInputs(new Date(2026, 5, 23, 8, 0))).toEqual({
      date: '2026-06-23',
      time: '08:00',
    });
  });

  it('drops minutes when converting iso values for hour-only inputs', () => {
    expect(isoToDateTimeInputs('2026-06-23T15:56:00.000Z').time).toBe('15:00');
  });

  it('stores hour-only inputs with zeroed minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-23T00:00:00.000Z'));

    expect(dateTimeInputsToIso('2026-06-23', '15:56')).toBe('2026-06-23T15:00:00.000Z');

    vi.useRealTimers();
  });
});
