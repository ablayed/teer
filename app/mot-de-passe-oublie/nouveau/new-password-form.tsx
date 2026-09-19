'use client';

import { BrandPanel } from '@/components/auth/brand-panel';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { PasswordField } from '@/components/ui/password-field';
import { updatePasswordFromRecoveryAction } from '@/lib/actions/password-reset';
import { checkPasswordStrength } from '@/lib/format/password';
import { cn } from '@/lib/utils';
import { CheckCircle2, Circle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { type FormEvent, useMemo, useState } from 'react';

/**
 * Écran de saisie du nouveau mot de passe, atteint UNIQUEMENT par le rappel, sur une
 * session de récupération.
 *
 * Le seuil de robustesse est celui du projet — `checkPasswordStrength`, la même
 * fonction que l'inscription et le changement de mot de passe. Aucun seuil parallèle
 * n'est défini ici.
 *
 * Après succès l'utilisateur reste connecté et reprend le parcours normal par `/s`
 * (point d'entrée workspace, mur de consentement compris s'il s'applique).
 */
export function NewPasswordForm() {
  const t = useTranslations('auth');
  const tNew = useTranslations('auth.new_password');
  const tErrors = useTranslations('auth.errors');
  const tPasswordCriteria = useTranslations('auth.password_criteria');
  const router = useRouter();

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [clientError, setClientError] = useState<string | null>(null);

  const strength = useMemo(() => checkPasswordStrength(password), [password]);

  const update = useAction(updatePasswordFromRecoveryAction, {
    onSuccess: ({ data }) => {
      if (data?.ok) {
        router.replace('/s');
      }
    },
  });

  const criteria = [
    { key: 'minLength' as const, valid: strength.minLength },
    { key: 'hasUpper' as const, valid: strength.hasUpper },
    { key: 'hasLower' as const, valid: strength.hasLower },
    { key: 'hasDigit' as const, valid: strength.hasDigit },
    { key: 'hasSpecial' as const, valid: strength.hasSpecial },
  ];
  const strengthScore = criteria.filter((criterion) => criterion.valid).length;

  const serverErrorCode =
    update.result.data?.ok === false ? update.result.data.errorCode : undefined;
  const serverError = serverErrorCode ? tErrors(serverErrorCode) : null;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setClientError(null);

    if (!strength.allValid) {
      setClientError(tErrors('weak_password'));
      return;
    }

    if (password !== confirmPassword) {
      setClientError(tErrors('password_mismatch'));
      return;
    }

    update.execute({ password, confirmPassword });
  }

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <BrandPanel />
      <div className="flex flex-1 flex-col items-center justify-center bg-surface px-5 py-10 md:bg-canvas md:px-12">
        <section
          aria-label={tNew('aria')}
          className="w-full max-w-[420px] md:rounded-2xl md:border md:border-border md:bg-surface md:p-8 md:shadow-warm-2"
        >
          <h1 className="mb-1 font-display text-3xl tracking-tight">{tNew('title')}</h1>
          <p className="mb-6 text-sm text-muted">{tNew('subtitle')}</p>

          <form className="space-y-5" onSubmit={onSubmit}>
            <div className="space-y-2">
              <Label htmlFor="new-password">{tNew('password_label')}</Label>
              <PasswordField
                autoComplete="new-password"
                hideLabel={t('common.hide_password')}
                id="new-password"
                minLength={10}
                name="password"
                onChange={(event) => setPassword(event.target.value)}
                required
                showLabel={t('common.show_password')}
                value={password}
              />
            </div>

            <div aria-live="polite">
              <ul aria-label={tPasswordCriteria('ariaLabel')} className="space-y-1.5">
                {criteria.map((criterion) => {
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

            <div className="space-y-2">
              <Label htmlFor="confirm-password">{tNew('confirm_label')}</Label>
              <PasswordField
                autoComplete="new-password"
                hideLabel={t('common.hide_password')}
                id="confirm-password"
                minLength={10}
                name="confirmPassword"
                onChange={(event) => setConfirmPassword(event.target.value)}
                required
                showLabel={t('common.show_password')}
                value={confirmPassword}
              />
            </div>

            <p className="text-sm text-muted">{tNew('sessions_notice')}</p>

            {(clientError || serverError) && (
              <p className="text-sm text-danger" role="alert">
                {clientError ?? serverError}
              </p>
            )}

            <Button
              aria-busy={update.isExecuting}
              className="w-full"
              disabled={update.isExecuting || !strength.allValid}
              type="submit"
            >
              {update.isExecuting ? tNew('submit_loading') : tNew('submit')}
            </Button>
          </form>
        </section>
      </div>
    </div>
  );
}
