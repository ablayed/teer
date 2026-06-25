import { checkPasswordStrength } from '@/lib/format/password';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// Mirror of the schema in lib/actions/account.ts — tested independently
// so we don't import from a 'use server' module in vitest.
const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z.string().refine((p) => checkPasswordStrength(p).allValid, {
      message: 'weak_password',
    }),
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: 'mismatch',
    path: ['confirmPassword'],
  })
  .refine((d) => d.newPassword !== d.currentPassword, {
    message: 'same_as_current',
    path: ['newPassword'],
  });

const STRONG = 'NewPassw0rd!';
const STRONG2 = 'AnotherPass2@';

describe('changePasswordSchema', () => {
  it('rejects an empty currentPassword', () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: '',
      newPassword: STRONG,
      confirmPassword: STRONG,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a weak newPassword', () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: 'any',
      newPassword: 'weak',
      confirmPassword: 'weak',
    });
    expect(result.success).toBe(false);
  });

  it('rejects when newPassword does not match confirmPassword', () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: 'old',
      newPassword: STRONG,
      confirmPassword: STRONG2,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('confirmPassword');
    }
  });

  it('rejects when newPassword equals currentPassword', () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: STRONG,
      newPassword: STRONG,
      confirmPassword: STRONG,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('newPassword');
    }
  });

  it('accepts a valid change', () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: 'OldPass1!',
      newPassword: STRONG,
      confirmPassword: STRONG,
    });
    expect(result.success).toBe(true);
  });
});
