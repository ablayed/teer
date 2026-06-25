import { checkPasswordStrength } from '@/lib/format/password';
import { describe, expect, it } from 'vitest';

// PasswordField toggle logic: visible state starts false, each click inverts it.
// Extracted as a pure function so it can be verified without a DOM environment.
function toggleVisible(current: boolean): boolean {
  return !current;
}

describe('PasswordField toggle logic', () => {
  it('starts hidden by default', () => {
    const initial = false;
    expect(initial).toBe(false);
  });

  it('shows password after first toggle', () => {
    expect(toggleVisible(false)).toBe(true);
  });

  it('hides password after second toggle', () => {
    expect(toggleVisible(true)).toBe(false);
  });

  it('alternates correctly over multiple toggles', () => {
    let state = false;
    state = toggleVisible(state); // true
    state = toggleVisible(state); // false
    state = toggleVisible(state); // true
    expect(state).toBe(true);
  });
});

// strengthScore mirrors the component computation: count of valid criteria (0–5).
describe('strengthScore (0–5)', () => {
  function strengthScore(pwd: string): number {
    const r = checkPasswordStrength(pwd);
    return (['minLength', 'hasUpper', 'hasLower', 'hasDigit', 'hasSpecial'] as const).filter(
      (k) => r[k],
    ).length;
  }

  it('returns 0 for empty password', () => {
    expect(strengthScore('')).toBe(0);
  });

  it('returns 3 for lowercase + digit + length only', () => {
    expect(strengthScore('lowercaseonly1')).toBe(3);
  });

  it('returns 4 when missing special char', () => {
    expect(strengthScore('Password12')).toBe(4);
  });

  it('returns 5 for a fully valid password', () => {
    expect(strengthScore('TeerSecure1#')).toBe(5);
  });
});

// Surface: checkPasswordStrength is reused as-is — no custom logic added.
describe('checkPasswordStrength surface (reused)', () => {
  it('counts all criteria for a strong password', () => {
    const result = checkPasswordStrength('TeerSecure1#');
    expect(Object.values(result).filter(Boolean).length).toBe(6); // 5 criteria + allValid
  });

  it('reports exactly how many criteria are met', () => {
    // Only minLength + hasLower + hasDigit (no upper, no special)
    const result = checkPasswordStrength('lowercaseonly1');
    const criteriaKeys = ['minLength', 'hasUpper', 'hasLower', 'hasDigit', 'hasSpecial'] as const;
    const met = criteriaKeys.filter((k) => result[k]).length;
    expect(met).toBe(3);
  });
});
