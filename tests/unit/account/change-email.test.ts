import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// Mirror of the schema in lib/actions/account.ts
const changeEmailSchema = z.object({
  newEmail: z.string().email(),
  currentPassword: z.string().min(1),
});

describe('changeEmailSchema', () => {
  it('rejects an invalid email', () => {
    const result = changeEmailSchema.safeParse({
      newEmail: 'not-an-email',
      currentPassword: 'anypass',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty email', () => {
    const result = changeEmailSchema.safeParse({
      newEmail: '',
      currentPassword: 'anypass',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty password', () => {
    const result = changeEmailSchema.safeParse({
      newEmail: 'new@example.com',
      currentPassword: '',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid input', () => {
    const result = changeEmailSchema.safeParse({
      newEmail: 'new@example.com',
      currentPassword: 'anypass',
    });
    expect(result.success).toBe(true);
  });
});
