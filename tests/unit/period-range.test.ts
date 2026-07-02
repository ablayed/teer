import { resolvePeriodRange, toDateInput } from '@/lib/periods/date-range';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('resolvePeriodRange', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-23T15:56:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('supports yesterday as a dedicated preset', () => {
    const range = resolvePeriodRange({
      allowedPresets: ['today', 'yesterday', '7j', '30j'],
      defaultPreset: '30j',
      period: 'yesterday',
    });

    expect(range.activePeriod).toBe('yesterday');
    expect(toDateInput(range.from)).toBe('2026-06-22');
    expect(toDateInput(range.to)).toBe('2026-06-22');
  });

  it('supports month (Ce mois-ci) from the first day of the current month', () => {
    const range = resolvePeriodRange({
      allowedPresets: ['today', '7j', '30j', '90j', 'month'],
      defaultPreset: '30j',
      period: 'month',
    });

    expect(range.activePeriod).toBe('month');
    expect(toDateInput(range.from)).toBe('2026-06-01');
  });

  it('returns custom when both explicit bounds are present', () => {
    const range = resolvePeriodRange({
      allowedPresets: ['today', '7j', '30j'],
      defaultPreset: '30j',
      from: '2026-06-01',
      period: '7j',
      to: '2026-06-05',
    });

    expect(range.activePeriod).toBe('custom');
    expect(toDateInput(range.from)).toBe('2026-06-01');
    expect(toDateInput(range.to)).toBe('2026-06-05');
  });
});
