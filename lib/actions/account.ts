'use server';

import { authActionClient } from '@/lib/actions/safe-action';
import { env } from '@/lib/env';
import { checkPasswordStrength } from '@/lib/format/password';
import { z } from 'zod';

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

const changeEmailSchema = z.object({
  newEmail: z.string().email(),
  currentPassword: z.string().min(1),
});

export const changePasswordAction = authActionClient
  .metadata({ actionName: 'account.change_password', section: 'account' })
  .inputSchema(changePasswordSchema)
  .action(async ({ ctx, parsedInput }) => {
    const { error: reAuthError } = await ctx.supabase.auth.signInWithPassword({
      email: ctx.user.email ?? '',
      password: parsedInput.currentPassword,
    });

    if (reAuthError) {
      return { ok: false as const, errorCode: 'wrong_current_password' as const };
    }

    const { error } = await ctx.supabase.auth.updateUser({
      password: parsedInput.newPassword,
    });

    if (error) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    return { ok: true as const };
  });

export const changeEmailAction = authActionClient
  .metadata({ actionName: 'account.change_email', section: 'account' })
  .inputSchema(changeEmailSchema)
  .action(async ({ ctx, parsedInput }) => {
    if (parsedInput.newEmail === ctx.user.email) {
      return { ok: false as const, errorCode: 'same_email' as const };
    }

    const { error: reAuthError } = await ctx.supabase.auth.signInWithPassword({
      email: ctx.user.email ?? '',
      password: parsedInput.currentPassword,
    });

    if (reAuthError) {
      return { ok: false as const, errorCode: 'wrong_current_password' as const };
    }

    const { error } = await ctx.supabase.auth.updateUser(
      { email: parsedInput.newEmail },
      { emailRedirectTo: `${env.NEXT_PUBLIC_APP_URL}/auth/callback` },
    );

    if (error) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    return { ok: true as const };
  });
