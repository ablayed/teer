'use server';

import { mapSupabaseAuthError } from '@/lib/actions/auth-errors';
import { actionClient, authActionClient } from '@/lib/actions/safe-action';
import { env } from '@/lib/env';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { z } from 'zod';

async function authInputSchema() {
  const t = await getTranslations('auth.errors');

  return z.object({
    email: z.string().email(t('invalid_email')),
    password: z.string().min(10, t('weak_password')),
  });
}

export const signUpAction = actionClient
  .metadata({ actionName: 'auth.sign_up', section: 'auth' })
  .inputSchema(authInputSchema)
  .action(async ({ parsedInput }) => {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.signUp({
      email: parsedInput.email,
      password: parsedInput.password,
      options: {
        emailRedirectTo: `${env.NEXT_PUBLIC_APP_URL}/auth/callback`,
      },
    });

    if (error) {
      const code = mapSupabaseAuthError(error);
      if (process.env.NODE_ENV !== 'production') {
        console.error('[signUpAction]', { code, raw: error });
      }
      return { ok: false as const, errorCode: code };
    }

    if (data.user?.identities && data.user.identities.length === 0) {
      return { ok: false as const, errorCode: 'email_already_registered' as const };
    }

    return { ok: true as const, requiresEmailVerification: true };
  });

export const signInAction = actionClient
  .metadata({ actionName: 'auth.sign_in', section: 'auth' })
  .inputSchema(authInputSchema)
  .action(async ({ parsedInput }) => {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.signInWithPassword({
      email: parsedInput.email,
      password: parsedInput.password,
    });

    if (error) {
      const code = mapSupabaseAuthError(error);
      if (process.env.NODE_ENV !== 'production') {
        console.error('[signInAction]', { code, raw: error });
      }
      return { ok: false as const, errorCode: code };
    }

    redirect('/tableau');
  });

export const signOutAction = authActionClient
  .metadata({ actionName: 'auth.sign_out', section: 'auth' })
  .action(async ({ ctx }) => {
    await ctx.supabase.auth.signOut();
    redirect('/');
  });
