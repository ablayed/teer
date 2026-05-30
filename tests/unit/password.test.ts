import { checkPasswordStrength } from '@/lib/format/password';
import { describe, expect, it } from 'vitest';

describe('checkPasswordStrength', () => {
  it('rejects an empty password', () => {
    expect(checkPasswordStrength('')).toEqual({
      minLength: false,
      hasUpper: false,
      hasLower: false,
      hasDigit: false,
      hasSpecial: false,
      allValid: false,
    });
  });

  it('rejects a password shorter than 10 characters', () => {
    const result = checkPasswordStrength('Aa1!');

    expect(result.minLength).toBe(false);
    expect(result.allValid).toBe(false);
  });

  it('rejects a password without an uppercase letter', () => {
    const result = checkPasswordStrength('password1!');

    expect(result.hasUpper).toBe(false);
    expect(result.allValid).toBe(false);
  });

  it('rejects a password without a lowercase letter', () => {
    const result = checkPasswordStrength('PASSWORD1!');

    expect(result.hasLower).toBe(false);
    expect(result.allValid).toBe(false);
  });

  it('rejects a password without a digit', () => {
    const result = checkPasswordStrength('Password!!');

    expect(result.hasDigit).toBe(false);
    expect(result.allValid).toBe(false);
  });

  it('rejects a password without a special character', () => {
    const result = checkPasswordStrength('Password12');

    expect(result.hasSpecial).toBe(false);
    expect(result.allValid).toBe(false);
  });

  it('accepts a strong password with punctuation', () => {
    const result = checkPasswordStrength('Password12!');

    expect(result.allValid).toBe(true);
  });

  it('accepts a strong password with a non-alphanumeric symbol', () => {
    const result = checkPasswordStrength('TeerSecure1#');

    expect(result).toMatchObject({
      minLength: true,
      hasUpper: true,
      hasLower: true,
      hasDigit: true,
      hasSpecial: true,
      allValid: true,
    });
  });
});
