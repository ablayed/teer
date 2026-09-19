'use client';

import { BrandPanel } from '@/components/auth/brand-panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { requestPasswordResetAction } from '@/lib/actions/password-reset';
import { MailCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { z } from 'zod';

/**
 * Écran de demande d'un lien de réinitialisation.
 *
 * **Aucune branche sur l'existence du compte.** L'action rend toujours le même
 * `{ ok: true }` ; cet écran rend donc toujours le même accusé de réception. La
 * seule bifurcation possible est la limitation de débit locale par IP, qui ne
 * dépend d'aucun compte, et l'invalidité SYNTAXIQUE de l'adresse — une validation
 * de format, jamais d'existence.
 *
 * Aucune durée n'est affichée : le TTL de production n'a pas été mesuré, et
 * annoncer un nombre sur la foi d'une mesure locale serait une promesse fausse.
 */
export function ForgotPasswordForm() {
  const t = useTranslations('auth');
  const tForgot = useTranslations('auth.forgot_password');
  const tErrors = useTranslations('auth.errors');

  const [clientError, setClientError] = useState<string | null>(null);
  const [emailSubmitted, setEmailSubmitted] = useState('');
  const [sent, setSent] = useState(false);

  const request = useAction(requestPasswordResetAction, {
    onSuccess: ({ data }) => {
      if (data?.ok) {
        setSent(true);
      }
    },
  });

  const rateLimited = request.result.data?.ok === false;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setClientError(null);

    const formData = new FormData(event.currentTarget);
    const email = String(formData.get('email') ?? '');

    const parsed = z.string().email().safeParse(email);
    if (!parsed.success) {
      setClientError(tErrors('invalid_email'));
      return;
    }

    setEmailSubmitted(email);
    request.execute({ email: parsed.data });
  }

  if (sent) {
    return (
      <div className="flex min-h-dvh flex-col md:flex-row">
        <BrandPanel />
        <div className="flex flex-1 flex-col items-center justify-center bg-surface px-5 py-12 md:bg-canvas md:px-12">
          <section
            aria-label={tForgot('sent_aria')}
            className="w-full max-w-[420px] space-y-5 md:rounded-2xl md:border md:border-border md:bg-surface md:p-8 md:shadow-warm-2"
          >
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-success-subtle text-success">
                <MailCheck aria-hidden="true" className="size-5" />
              </span>
              <h1 className="font-display text-2xl tracking-tight">{tForgot('sent_title')}</h1>
            </div>
            <p className="text-sm leading-6 text-muted">
              {tForgot('sent_body', { email: emailSubmitted })}
            </p>
            <p className="text-sm text-muted">{tForgot('sent_spam')}</p>
            <p className="text-sm text-muted">{tForgot('sent_expiry')}</p>
            <Link
              className="inline-block text-sm text-accent-deep underline underline-offset-2"
              href="/connexion"
            >
              {tForgot('back_to_signin')}
            </Link>
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
          aria-label={tForgot('aria')}
          className="w-full max-w-[420px] md:rounded-2xl md:border md:border-border md:bg-surface md:p-8 md:shadow-warm-2"
        >
          <h1 className="mb-1 font-display text-3xl tracking-tight">{tForgot('title')}</h1>
          <p className="mb-6 text-sm text-muted">{tForgot('subtitle')}</p>

          <form className="space-y-5" onSubmit={onSubmit}>
            <div className="space-y-2">
              <Label htmlFor="reset-email">{t('email_label')}</Label>
              <Input autoComplete="username" id="reset-email" name="email" required type="email" />
            </div>

            {(clientError || rateLimited) && (
              <p className="text-sm text-danger" role="alert">
                {clientError ?? tErrors('reset_rate_limited')}
              </p>
            )}

            <Button
              aria-busy={request.isExecuting}
              className="w-full"
              disabled={request.isExecuting}
              type="submit"
            >
              {request.isExecuting ? tForgot('submit_loading') : tForgot('submit')}
            </Button>

            <Link
              className="block text-center text-sm text-accent-deep underline underline-offset-2"
              href="/connexion"
            >
              {tForgot('back_to_signin')}
            </Link>
          </form>
        </section>
      </div>
    </div>
  );
}
