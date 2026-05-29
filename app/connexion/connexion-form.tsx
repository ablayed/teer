'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Wordmark } from '@/components/wordmark';
import { signInAction, signUpAction } from '@/lib/actions/auth';
import type { AuthErrorCode } from '@/lib/actions/auth-errors';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';

type AuthMode = 'signin' | 'signup';

const authErrorCodes = [
  'invalid_credentials',
  'email_already_registered',
  'rate_limited',
  'email_not_confirmed',
  'weak_password',
  'unknown',
] as const satisfies readonly AuthErrorCode[];

function isAuthErrorCode(errorCode: string): errorCode is AuthErrorCode {
  return authErrorCodes.includes(errorCode as AuthErrorCode);
}

export function ConnexionForm() {
  const t = useTranslations('auth');
  const tErrors = useTranslations('auth.errors');
  const searchParams = useSearchParams();
  const mode: AuthMode = searchParams.get('mode') === 'signup' ? 'signup' : 'signin';
  const [clientError, setClientError] = useState<string | null>(null);
  const [verificationSent, setVerificationSent] = useState(false);
  const lastSubmitRef = useRef(0);
  const signUp = useAction(signUpAction);
  const signIn = useAction(signInAction);

  const tabs: Array<{ mode: AuthMode; label: string }> = [
    { mode: 'signin', label: t('signin_tab') },
    { mode: 'signup', label: t('signup_tab') },
  ];

  const schema = useMemo(
    () =>
      z.object({
        email: z.string().email(tErrors('invalid_email')),
        password: z.string().min(10, tErrors('weak_password')),
      }),
    [tErrors],
  );

  useEffect(() => {
    if (signUp.result.data?.ok) {
      setVerificationSent(true);
    }
  }, [signUp.result.data]);

  function errorMessageFor(errorCode: string | undefined): string | null {
    if (!errorCode) {
      return null;
    }

    return isAuthErrorCode(errorCode) ? tErrors(errorCode) : tErrors('unknown');
  }

  const signUpErrorCode =
    signUp.result.data?.ok === false ? signUp.result.data.errorCode : undefined;
  const signInErrorCode =
    signIn.result.data?.ok === false ? signIn.result.data.errorCode : undefined;

  const actionError =
    errorMessageFor(signUpErrorCode) ??
    errorMessageFor(signInErrorCode) ??
    signIn.result.serverError ??
    signUp.result.serverError ??
    null;

  const validationError =
    signIn.result.validationErrors || signUp.result.validationErrors ? tErrors('generic') : null;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const now = Date.now();
    if (now - lastSubmitRef.current < 1000) {
      return;
    }
    lastSubmitRef.current = now;

    setClientError(null);

    const formData = new FormData(event.currentTarget);
    const parsed = schema.safeParse({
      email: formData.get('email'),
      password: formData.get('password'),
    });

    if (!parsed.success) {
      setClientError(parsed.error.issues[0]?.message ?? tErrors('generic'));
      return;
    }

    if (mode === 'signup') {
      signUp.execute(parsed.data);
      return;
    }

    signIn.execute(parsed.data);
  }

  return (
    <section
      aria-label={t('form_label')}
      className="w-full max-w-[400px] rounded-2xl border border-border bg-surface p-8 shadow-1"
    >
      <div className="mb-8 flex justify-center">
        <Wordmark size="md" />
      </div>

      <div className="mb-6 grid grid-cols-2 gap-2 rounded-lg bg-canvas p-1">
        {tabs.map((tab) => (
          <Link
            className={cn(
              'rounded-md px-3 py-2 text-center text-sm font-medium transition',
              mode === tab.mode ? 'bg-surface text-text shadow-1' : 'text-muted hover:text-text',
            )}
            href={`/connexion?mode=${tab.mode}`}
            key={tab.mode}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      {verificationSent ? (
        <p className="rounded-lg border border-accent-soft bg-canvas p-4 text-sm leading-6 text-text">
          {t('verify_email')}
        </p>
      ) : (
        <form className="space-y-5" onSubmit={onSubmit}>
          <div className="space-y-2">
            <Label htmlFor="email">{t('email_label')}</Label>
            <Input autoComplete="email" id="email" name="email" required type="email" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">{t('password_label')}</Label>
            <Input
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              id="password"
              minLength={10}
              name="password"
              required
              type="password"
            />
          </div>

          {clientError || actionError || validationError ? (
            <p className="text-sm text-danger" role="alert">
              {clientError ?? actionError ?? validationError}
            </p>
          ) : null}

          <Button
            className="w-full"
            disabled={signUp.isExecuting || signIn.isExecuting}
            type="submit"
          >
            {t('submit')}
          </Button>
        </form>
      )}
    </section>
  );
}
