'use server';

import { mapSupabaseAuthError } from '@/lib/actions/auth-errors';
import { actionClient, authActionClient } from '@/lib/actions/safe-action';
import { sendSignupConfirmationEmail } from '@/lib/email/signup-confirmation';
import { env } from '@/lib/env';
import { checkPasswordStrength } from '@/lib/format/password';
import {
  deleteUserForFailedSignup,
  getSignupConsentDocuments,
  persistSignupConsents,
} from '@/lib/legal/consent';
import { checkAuthRateLimit, getClientIp } from '@/lib/security/auth-rate-limit';
import type { Database } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import * as Sentry from '@sentry/nextjs';
import { createClient } from '@supabase/supabase-js';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
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

/**
 * Destination après une connexion réussie : TOUJOURS le point d'entrée workspace.
 *
 * Rediriger directement vers `/tableau` (ou vers la section demandée) faisait
 * entrer un utilisateur multi-boutiques dans sa boutique par DÉFAUT sans qu'il
 * ait choisi. `/s` tranche : entrée automatique s'il n'a qu'une boutique, choix
 * explicite au-delà. L'intention de navigation est transportée en `next` et
 * réduite à une section par `/s`, jamais à un identifiant de ressource.
 */
function postSignInPath(redirectTo: string | undefined): string {
  const target = safeRedirectPath(redirectTo);

  if (target === '/s' || target.startsWith('/s/') || target.startsWith('/s?')) {
    return target;
  }

  return `/s?next=${encodeURIComponent(target)}`;
}

function createSupabaseAdminClient() {
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function isConfirmationEmailFailure(error: {
  message?: string;
  code?: string;
}): boolean {
  return (
    error.code === 'unexpected_failure' &&
    (error.message ?? '').toLowerCase().includes('confirmation email')
  );
}

function rewriteConfirmationRedirect(actionLink: string, redirectTo: string): string {
  const url = new URL(actionLink);
  url.searchParams.set('redirect_to', redirectTo);
  return url.toString();
}

function formatSupabaseAuthError(supabaseError: unknown): {
  message: string | null;
  code: string | null;
  status: number | null;
  details: string | null;
  hint: string | null;
} | null {
  if (!supabaseError || typeof supabaseError !== 'object') {
    return null;
  }

  const typedError = supabaseError as {
    message?: string;
    code?: string;
    status?: number;
    details?: string;
    hint?: string;
  };

  return {
    message: typedError.message ?? null,
    code: typedError.code ?? null,
    status: typedError.status ?? null,
    details: typedError.details ?? null,
    hint: typedError.hint ?? null,
  };
}

export const signUpAction = actionClient
  .metadata({ actionName: 'auth.sign_up', section: 'auth' })
  .inputSchema(signUpInputSchema)
  .action(async ({ parsedInput }) => {
    // Rate-limit par IP AVANT tout accès DB / création de compte (anti-abus signup).
    const rate = await checkAuthRateLimit('signup', getClientIp(await headers()));
    if (!rate.ok) {
      return { ok: false as const, errorCode: 'rate_limited' as const };
    }

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
      if (isConfirmationEmailFailure(error)) {
        const admin = createSupabaseAdminClient();
        const { data: generatedLink, error: generateError } = await admin.auth.admin.generateLink({
          type: 'signup',
          email: parsedInput.email,
          password: parsedInput.password,
          options: {
            redirectTo: callbackUrl.toString(),
          },
        });

        if (generateError || !generatedLink.user?.id || !generatedLink.properties?.action_link) {
          const fallbackError = generateError ?? error;
          const fallbackCode = mapSupabaseAuthError(fallbackError);
          Sentry.captureException(fallbackError, {
            tags: { action: 'auth.sign_up', fallback: 'generate_signup_link' },
            extra: {
              fallbackReason: 'confirmation_email_failure',
              email: parsedInput.email,
              code: fallbackCode,
            },
          });
          return { ok: false as const, errorCode: fallbackCode };
        }

        const confirmationUrl = rewriteConfirmationRedirect(
          generatedLink.properties.action_link,
          callbackUrl.toString(),
        );
        const { data: mailData, error: mailError } = await sendSignupConfirmationEmail({
          confirmationUrl,
          email: parsedInput.email,
        });

        if (mailError || !mailData?.id) {
          await deleteUserForFailedSignup(generatedLink.user.id);
          Sentry.captureException(new Error('Failed to send signup confirmation email'), {
            tags: { action: 'auth.sign_up', fallback: 'generate_signup_link' },
            extra: {
              email: parsedInput.email,
            },
          });
          return { ok: false as const, errorCode: 'confirmation_email_failed' as const };
        }

        const consentResult = await persistSignupConsents(
          generatedLink.user.id,
          currentDocuments.documents,
        );
        if (!consentResult.ok) {
          await deleteUserForFailedSignup(generatedLink.user.id);
          return { ok: false as const, errorCode: 'consent_record_failed' as const };
        }

        return { ok: true as const, requiresEmailVerification: true };
      }

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
      const unexpectedError = new Error('Supabase signup returned no user id');

      Sentry.captureException(unexpectedError, {
        tags: { action: 'auth.sign_up' },
        extra: {
          reason: 'missing_user_id',
          email: parsedInput.email,
          hasSupabaseError: Boolean(error),
          supabaseError: formatSupabaseAuthError(error),
          userMetadataPresent: Boolean(data.user),
          identitiesCount: data.user?.identities?.length ?? null,
        },
      });

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
    // Rate-limit par IP AVANT toute vérification d'identifiants (anti brute-force).
    // Message générique de throttling — ne révèle jamais l'existence de l'email.
    const rate = await checkAuthRateLimit('login', getClientIp(await headers()));
    if (!rate.ok) {
      return { ok: false as const, errorCode: 'rate_limited' as const };
    }

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

    redirect(postSignInPath(parsedInput.redirectTo));
  });

export const signOutAction = authActionClient
  .metadata({ actionName: 'auth.sign_out', section: 'auth' })
  .action(async ({ ctx }) => {
    await ctx.supabase.auth.signOut({ scope: 'local' });
    redirect('/');
  });
