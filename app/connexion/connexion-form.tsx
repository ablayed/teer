'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Wordmark } from '@/components/wordmark';
import { signInAction, signUpAction } from '@/lib/actions/auth';
import { cn } from '@/lib/utils';
import messages from '@/messages/fr.json';
import { useAction } from 'next-safe-action/hooks';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { z } from 'zod';

type AuthMode = 'signin' | 'signup';

const tabs: Array<{ mode: AuthMode; label: string }> = [
  { mode: 'signin', label: messages.auth.signin_tab },
  { mode: 'signup', label: messages.auth.signup_tab },
];

export function ConnexionForm() {
  const searchParams = useSearchParams();
  const mode: AuthMode = searchParams.get('mode') === 'signup' ? 'signup' : 'signin';
  const [clientError, setClientError] = useState<string | null>(null);
  const [verificationSent, setVerificationSent] = useState(false);
  const signUp = useAction(signUpAction);
  const signIn = useAction(signInAction);

  const schema = useMemo(
    () =>
      z.object({
        email: z.string().email(messages.auth.errors.invalid_email),
        password: z.string().min(10, messages.auth.errors.weak_password),
      }),
    [],
  );

  useEffect(() => {
    if (signUp.result.data?.ok) {
      setVerificationSent(true);
    }
  }, [signUp.result.data]);

  const actionError =
    signIn.result.data?.ok === false
      ? messages.auth.errors.invalid_credentials
      : (signIn.result.serverError ?? signUp.result.serverError ?? null);

  const validationError =
    signIn.result.validationErrors || signUp.result.validationErrors
      ? messages.auth.errors.generic
      : null;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setClientError(null);

    const formData = new FormData(event.currentTarget);
    const parsed = schema.safeParse({
      email: formData.get('email'),
      password: formData.get('password'),
    });

    if (!parsed.success) {
      setClientError(parsed.error.issues[0]?.message ?? messages.auth.errors.generic);
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
      aria-label={messages.auth.form_label}
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
          {messages.auth.verify_email}
        </p>
      ) : (
        <form className="space-y-5" onSubmit={onSubmit}>
          <div className="space-y-2">
            <Label htmlFor="email">{messages.auth.email_label}</Label>
            <Input autoComplete="email" id="email" name="email" required type="email" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">{messages.auth.password_label}</Label>
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
            {messages.auth.submit}
          </Button>
        </form>
      )}
    </section>
  );
}
