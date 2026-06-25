'use client';

import { BrandPanel } from '@/components/auth/brand-panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordField } from '@/components/ui/password-field';
import { signInAction, signUpAction } from '@/lib/actions/auth';
import type { AuthErrorCode } from '@/lib/actions/auth-errors';
import { checkPasswordStrength } from '@/lib/format/password';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import { CheckCircle2, Circle, MailCheck } from 'lucide-react';
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
  'legal_consent_required',
  'legal_documents_unavailable',
  'consent_record_failed',
  'confirmation_email_failed',
  'unknown',
] as const satisfies readonly AuthErrorCode[];

function isAuthErrorCode(errorCode: string): errorCode is AuthErrorCode {
  return (authErrorCodes as readonly string[]).includes(errorCode);
}

export function ConnexionForm() {
  const t = useTranslations('auth');
  const tErrors = useTranslations('auth.errors');
  const tPasswordCriteria = useTranslations('auth.password_criteria');
  const searchParams = useSearchParams();
  const mode: AuthMode = searchParams.get('mode') === 'signup' ? 'signup' : 'signin';
  const redirectTo = searchParams.get('redirectTo') ?? undefined;
  const reason = searchParams.get('reason');

  const [clientError, setClientError] = useState<string | null>(null);
  const [verificationSent, setVerificationSent] = useState(false);
  const [emailSubmitted, setEmailSubmitted] = useState('');
  const [password, setPassword] = useState('');
  const [acceptedLegal, setAcceptedLegal] = useState(false);
  const [resendStatus, setResendStatus] = useState<'idle' | 'loading' | 'sent' | 'error'>('idle');
  const [resendCooldown, setResendCooldown] = useState(0);

  const lastSubmitRef = useRef(0);
  const cooldownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const signUp = useAction(signUpAction);
  const signIn = useAction(signInAction);
  const passwordStrength = useMemo(() => checkPasswordStrength(password), [password]);

  const tabs: Array<{ mode: AuthMode; label: string }> = [
    { mode: 'signin', label: t('signin_tab') },
    { mode: 'signup', label: t('signup_tab') },
  ];

  function tabHref(tabMode: AuthMode): string {
    const params = new URLSearchParams();
    params.set('mode', tabMode);
    if (redirectTo) params.set('redirectTo', redirectTo);
    return `/connexion?${params.toString()}`;
  }

  const schema = useMemo(
    () =>
      z.object({
        email: z.string().email(tErrors('invalid_email')),
        password:
          mode === 'signup'
            ? z.string().refine((v) => checkPasswordStrength(v).allValid, {
                message: tErrors('weak_password'),
              })
            : z.string().min(10, tErrors('weak_password')),
        acceptedLegal:
          mode === 'signup'
            ? z.literal(true, { errorMap: () => ({ message: tErrors('legal_consent_required') }) })
            : z.boolean().optional(),
        redirectTo: z.string().trim().max(500).optional(),
      }),
    [mode, tErrors],
  );

  useEffect(() => {
    if (signUp.result.data?.ok) {
      setVerificationSent(true);
    }
  }, [signUp.result.data]);

  // Clear password after sign-in failure (non-enumeration)
  useEffect(() => {
    if (signIn.result.data?.ok === false) {
      setPassword('');
    }
  }, [signIn.result.data]);

  function startCooldown(seconds: number) {
    setResendCooldown(seconds);
    if (cooldownIntervalRef.current) clearInterval(cooldownIntervalRef.current);
    cooldownIntervalRef.current = setInterval(() => {
      setResendCooldown((c) => {
        if (c <= 1) {
          if (cooldownIntervalRef.current) {
            clearInterval(cooldownIntervalRef.current);
            cooldownIntervalRef.current = null;
          }
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  }

  useEffect(() => {
    return () => {
      if (cooldownIntervalRef.current) clearInterval(cooldownIntervalRef.current);
    };
  }, []);

  async function handleResend() {
    if (resendStatus === 'loading' || resendCooldown > 0 || !emailSubmitted) return;
    setResendStatus('loading');
    const supabase = createSupabaseBrowserClient();
    const { error } = await supabase.auth.resend({ type: 'signup', email: emailSubmitted });
    if (error) {
      setResendStatus('error');
    } else {
      setResendStatus('sent');
      startCooldown(60);
    }
  }

  function errorMessageFor(errorCode: string | undefined): string | null {
    if (!errorCode) return null;
    return isAuthErrorCode(errorCode) ? tErrors(errorCode) : tErrors('unknown');
  }

  const signUpErrorCode =
    signUp.result.data?.ok === false ? signUp.result.data.errorCode : undefined;
  const signInErrorCode =
    signIn.result.data?.ok === false ? signIn.result.data.errorCode : undefined;

  const isEmailNotConfirmed = signInErrorCode === 'email_not_confirmed';

  const actionError =
    errorMessageFor(signUpErrorCode) ??
    errorMessageFor(signInErrorCode) ??
    signIn.result.serverError ??
    signUp.result.serverError ??
    null;

  const validationError =
    signIn.result.validationErrors || signUp.result.validationErrors ? tErrors('generic') : null;

  const passwordCriteria = [
    { key: 'minLength' as const, valid: passwordStrength.minLength },
    { key: 'hasUpper' as const, valid: passwordStrength.hasUpper },
    { key: 'hasLower' as const, valid: passwordStrength.hasLower },
    { key: 'hasDigit' as const, valid: passwordStrength.hasDigit },
    { key: 'hasSpecial' as const, valid: passwordStrength.hasSpecial },
  ];

  const strengthScore = passwordCriteria.filter((c) => c.valid).length;

  const isExecuting = signUp.isExecuting || signIn.isExecuting;
  const submitDisabled =
    isExecuting || (mode === 'signup' && (!passwordStrength.allValid || !acceptedLegal));

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const now = Date.now();
    if (now - lastSubmitRef.current < 1000) return;
    lastSubmitRef.current = now;
    setClientError(null);

    const formData = new FormData(event.currentTarget);
    const emailValue = String(formData.get('email') ?? '');
    setEmailSubmitted(emailValue);

    const parsed = schema.safeParse({
      email: emailValue,
      password: formData.get('password'),
      acceptedLegal: formData.get('acceptedLegal') === 'on',
      redirectTo,
    });

    if (!parsed.success) {
      setClientError(parsed.error.issues[0]?.message ?? tErrors('generic'));
      return;
    }

    if (mode === 'signup') {
      signUp.execute({
        email: parsed.data.email,
        password: parsed.data.password,
        acceptedLegal: true,
        redirectTo,
      });
      return;
    }

    signIn.execute(parsed.data);
  }

  // Verify email screen shown after successful sign-up
  if (verificationSent) {
    return (
      <div className="flex min-h-dvh flex-col md:flex-row">
        <BrandPanel />
        <div className="flex flex-1 flex-col items-center justify-center bg-surface px-5 py-12 md:bg-canvas md:px-12">
          <section
            aria-label={t('signup.verify_aria')}
            className="w-full max-w-[420px] space-y-5 md:rounded-2xl md:border md:border-border md:bg-surface md:p-8 md:shadow-warm-2"
          >
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-success-subtle text-success">
                <MailCheck aria-hidden="true" className="size-5" />
              </span>
              <h1 className="font-display text-2xl tracking-tight">{t('signup.verify_title')}</h1>
            </div>
            <p className="text-sm leading-6 text-muted">
              {t('signup.verify_body', { email: emailSubmitted })}
            </p>
            <p className="text-sm text-muted">{t('signup.verify_spam')}</p>

            {resendStatus === 'sent' && (
              <output className="block text-sm text-success">
                {t('signup.verify_resend_success')}
              </output>
            )}
            {resendStatus === 'error' && (
              <p className="text-sm text-danger" role="alert">
                {t('signup.verify_resend_error')}
              </p>
            )}

            <Button
              className="w-full"
              disabled={resendStatus === 'loading' || resendCooldown > 0}
              onClick={handleResend}
              type="button"
              variant="secondary"
            >
              {resendStatus === 'loading'
                ? t('signup.verify_resend_loading')
                : resendCooldown > 0
                  ? t('signup.verify_resend_cooldown', { seconds: resendCooldown })
                  : t('signup.verify_resend')}
            </Button>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <BrandPanel />
      <div className="flex flex-1 flex-col items-center justify-center bg-surface px-5 py-10 md:bg-canvas md:px-12">
        <section
          aria-label={t('form_label')}
          className="w-full max-w-[420px] md:rounded-2xl md:border md:border-border md:bg-surface md:p-8 md:shadow-warm-2"
        >
          <h1 className="mb-1 font-display text-3xl tracking-tight">
            {mode === 'signin' ? t('signin.title') : t('signup.title')}
          </h1>
          <p className="mb-6 text-sm text-muted">
            {mode === 'signin' ? t('signin.subtitle') : t('signup.subtitle')}
          </p>

          <div className="mb-6 grid grid-cols-2 gap-1.5 rounded-lg bg-canvas p-1">
            {tabs.map((tab) => (
              <Link
                className={cn(
                  'rounded-md px-3 py-2 text-center text-sm font-medium transition',
                  mode === tab.mode
                    ? 'bg-surface text-text shadow-1'
                    : 'text-muted hover:text-text',
                )}
                href={tabHref(tab.mode)}
                key={tab.mode}
              >
                {tab.label}
              </Link>
            ))}
          </div>

          {reason === 'idle' && (
            <output className="mb-5 block rounded-lg border border-border bg-canvas px-4 py-3 text-sm text-muted">
              {t('session_expired_idle')}
            </output>
          )}

          <form className="space-y-5" onSubmit={onSubmit}>
            <div className="space-y-2">
              <Label htmlFor="auth-email">{t('email_label')}</Label>
              <Input autoComplete="username" id="auth-email" name="email" required type="email" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="auth-password">{t('password_label')}</Label>
              <PasswordField
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                hideLabel={t('common.hide_password')}
                id="auth-password"
                minLength={10}
                name="password"
                onChange={(e) => setPassword(e.target.value)}
                required
                showLabel={t('common.show_password')}
                value={password}
              />
            </div>

            {mode === 'signup' && (
              <div aria-live="polite">
                <ul aria-label={tPasswordCriteria('ariaLabel')} className="space-y-1.5">
                  {passwordCriteria.map((criterion) => {
                    const Icon = criterion.valid ? CheckCircle2 : Circle;
                    return (
                      <li
                        className={cn(
                          'flex items-center gap-2 text-sm transition',
                          criterion.valid ? 'text-success' : 'text-muted',
                        )}
                        key={criterion.key}
                      >
                        <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                        <span>{tPasswordCriteria(criterion.key)}</span>
                      </li>
                    );
                  })}
                </ul>
                <meter
                  aria-hidden="true"
                  className="mt-2 w-full"
                  high={4}
                  low={2}
                  max={5}
                  optimum={5}
                  value={strengthScore}
                />
              </div>
            )}

            {mode === 'signup' && (
              <div className="rounded-xl border border-border bg-canvas/80 p-4">
                <label
                  className="flex cursor-pointer items-start gap-3 text-sm leading-6 text-text"
                  htmlFor="acceptedLegal"
                >
                  <input
                    checked={acceptedLegal}
                    className="mt-1 h-4 w-4 rounded border-border text-accent focus:ring-accent"
                    id="acceptedLegal"
                    name="acceptedLegal"
                    onChange={(e) => setAcceptedLegal(e.target.checked)}
                    type="checkbox"
                  />
                  <span>
                    {t('legal_consent_prefix')}{' '}
                    <Link
                      className="text-accent-deep underline underline-offset-2"
                      href="/conditions"
                      rel="noreferrer"
                      target="_blank"
                    >
                      {t('legal_consent_terms')}
                    </Link>{' '}
                    {t('legal_consent_joiner')}{' '}
                    <Link
                      className="text-accent-deep underline underline-offset-2"
                      href="/confidentialite"
                      rel="noreferrer"
                      target="_blank"
                    >
                      {t('legal_consent_privacy')}
                    </Link>
                    .
                  </span>
                </label>
              </div>
            )}

            {(clientError || actionError || validationError) && (
              <p className="text-sm text-danger" role="alert">
                {clientError ?? actionError ?? validationError}
              </p>
            )}

            {isEmailNotConfirmed && emailSubmitted && (
              <Button
                className="w-full"
                disabled={resendStatus === 'loading' || resendCooldown > 0}
                onClick={handleResend}
                type="button"
                variant="secondary"
              >
                {resendStatus === 'loading'
                  ? t('signup.verify_resend_loading')
                  : resendCooldown > 0
                    ? t('signup.verify_resend_cooldown', { seconds: resendCooldown })
                    : resendStatus === 'sent'
                      ? t('signup.verify_resend_success')
                      : t('signup.verify_resend')}
              </Button>
            )}

            <Button
              aria-busy={isExecuting}
              className="w-full"
              disabled={submitDisabled}
              type="submit"
            >
              {isExecuting
                ? mode === 'signin'
                  ? t('signin.submit_loading')
                  : t('signup.submit_loading')
                : mode === 'signin'
                  ? t('signin.submit')
                  : t('signup.submit')}
            </Button>
          </form>
        </section>
      </div>
    </div>
  );
}
