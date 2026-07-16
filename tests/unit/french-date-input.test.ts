import { frenchDateInputToIso, isoDateToFrenchDateInput } from '@/lib/periods/french-date-input';
import { describe, expect, it } from 'vitest';

describe('french date input helpers', () => {
  it('converts a valid DD/MM/YYYY value to the ISO date stored in period params', () => {
    expect(frenchDateInputToIso('30/06/2026')).toBe('2026-06-30');
  });

  it('formats an ISO period value as DD/MM/YYYY for display', () => {
    expect(isoDateToFrenchDateInput('2026-06-30')).toBe('30/06/2026');
  });

  it('rejects a calendar date that does not exist instead of correcting it', () => {
    expect(frenchDateInputToIso('31/02/2026')).toBeNull();
  });

  it('rejects incomplete or malformed values', () => {
    expect(frenchDateInputToIso('30/06/26')).toBeNull();
    expect(frenchDateInputToIso('32/01/2026')).toBeNull();
  });
});
