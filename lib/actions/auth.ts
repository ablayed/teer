'use server';

import { mapSupabaseAuthError } from '@/lib/actions/auth-errors';
import { actionClient, authActionClient } from '@/lib/actions/safe-action';
import { env } from '@/lib/env';
import { checkPasswordStrength } from '@/lib/format/password';
import {
  deleteUserForFailedSignup,
  getSignupConsentDocuments,
  persistSignupConsents,
} from '@/lib/legal/consent';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import * as Sentry from '@sentry/nextjs';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { z } from 'zod';

async function authInputSchema() {
  const t = await getTranslations('auth.errors');

  return z.object({
    email: z.string().email(t('invalid_email')),
    password: z.string().min(10, t('weak_password')),
    redirectTo: z.string().trim().max(500).optional(),
  });
}

async function signUpInputSchema() {
  const t = await getTranslations('auth.errors');

  return z.object({
    email: z.string().email(t('invalid_email')),
    password: z.string().refine((password) => checkPasswordStrength(password).allValid, {
      message: t('weak_password'),
    }),
    acceptedLegal: z.literal(true, {
      errorMap: () => ({ message: t('legal_consent_required') }),
    }),
    redirectTo: z.string().trim().max(500).optional(),
  });
}

function safeRedirectPath(path: string | undefined): string {
  if (!path || !path.startsWith('/') || path.startsWith('//')) {
    return '/tableau';
  }

  return path;
}

export const signUpAction = actionClient
  .metadata({ actionName: 'auth.sign_up', section: 'auth' })
  .inputSchema(signUpInputSchema)
  .action(async ({ parsedInput }) => {
    const currentDocuments = await getSignupConsentDocuments();
    if (!currentDocuments.ok) {
      return { ok: false as const, errorCode: 'legal_documents_unavailable' as const };
    }

    const supabase = await createSupabaseServerClient();
    const callbackUrl = new URL('/auth/callback', env.NEXT_PUBLIC_APP_URL);
    callbackUrl.searchParams.set('redirectTo', safeRedirectPath(parsedInput.redirectTo));

    const { data, error } = await supabase.auth.signUp({
      email: parsedInput.email,
      password: parsedInput.password,
      options: {
        emailRedirectTo: callbackUrl.toString(),
      },
    });

    if (error) {
      const code = mapSupabaseAuthError(error);
      if (process.env.NODE_ENV !== 'production') {
        Sentry.captureException(error, {
          tags: { action: 'auth.sign_up' },
          extra: { code },
        });
      }
      return { ok: false as const, errorCode: code };
    }

    if (data.user?.identities && data.user.identities.length === 0) {
      return { ok: false as const, errorCode: 'email_already_registered' as const };
    }

    const userId = data.user?.id;
    if (!userId) {
      return { ok: false as const, errorCode: 'unknown' as const };
    }

    const consentResult = await persistSignupConsents(userId, currentDocuments.documents);
    if (!consentResult.ok) {
      await deleteUserForFailedSignup(userId);
      return { ok: false as const, errorCode: 'consent_record_failed' as const };
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
        Sentry.captureException(error, {
          tags: { action: 'auth.sign_in' },
          extra: { code },
        });
      }
      return { ok: false as const, errorCode: code };
    }

    redirect(safeRedirectPath(parsedInput.redirectTo));
  });

export const signOutAction = authActionClient
  .metadata({ actionName: 'auth.sign_out', section: 'auth' })
  .action(async ({ ctx }) => {
    await ctx.supabase.auth.signOut();
    redirect('/');
  });
