'use server';

import { actionClient, authActionClient } from '@/lib/actions/safe-action';
import { env } from '@/lib/env';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import messages from '@/messages/fr.json';
import { redirect } from 'next/navigation';
import { z } from 'zod';

const authInputSchema = z.object({
  email: z.string().email(messages.auth.errors.invalid_email),
  password: z.string().min(10, messages.auth.errors.weak_password),
});

export const signUpAction = actionClient
  .metadata({ actionName: 'auth.sign_up', section: 'auth' })
  .inputSchema(authInputSchema)
  .action(async ({ parsedInput }) => {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.signUp({
      email: parsedInput.email,
      password: parsedInput.password,
      options: {
        emailRedirectTo: `${env.NEXT_PUBLIC_APP_URL}/auth/callback`,
      },
    });

    if (error) {
      return { ok: false, error: 'generic' as const };
    }

    return { ok: true, requiresEmailVerification: true };
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
      return { ok: false, error: 'invalid_credentials' as const };
    }

    redirect('/tableau');
  });

export const signOutAction = authActionClient
  .metadata({ actionName: 'auth.sign_out', section: 'auth' })
  .action(async ({ ctx }) => {
    await ctx.supabase.auth.signOut();
    redirect('/');
  });
