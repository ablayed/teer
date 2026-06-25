'use client';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordField } from '@/components/ui/password-field';
import { changeEmailAction, changePasswordAction } from '@/lib/actions/account';
import { checkPasswordStrength } from '@/lib/format/password';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import { type FormEvent, useEffect, useState } from 'react';

type PasswordErrorCode =
  | 'wrong_current_password'
  | 'update_failed'
  | 'mismatch'
  | 'same_as_current'
  | 'weak_password';

type EmailErrorCode = 'same_email' | 'wrong_current_password' | 'update_failed';

const passwordErrorCodes = [
  'wrong_current_password',
  'update_failed',
  'mismatch',
  'same_as_current',
  'weak_password',
] as const satisfies readonly PasswordErrorCode[];

const emailErrorCodes = [
  'same_email',
  'wrong_current_password',
  'update_failed',
] as const satisfies readonly EmailErrorCode[];

function isPasswordErrorCode(code: string): code is PasswordErrorCode {
  return passwordErrorCodes.includes(code as PasswordErrorCode);
}

function isEmailErrorCode(code: string): code is EmailErrorCode {
  return emailErrorCodes.includes(code as EmailErrorCode);
}

const PASSWORD_ERROR_KEY: Record<PasswordErrorCode, string> = {
  wrong_current_password: 'wrong_current',
  update_failed: 'update_failed',
  mismatch: 'mismatch',
  same_as_current: 'same_as_current',
  weak_password: 'update_failed',
};

const EMAIL_ERROR_KEY: Record<EmailErrorCode, string> = {
  same_email: 'same_email',
  wrong_current_password: 'wrong_current',
  update_failed: 'update_failed',
};

export function SettingsSecurity({ currentEmail }: { currentEmail: string }) {
  const t = useTranslations('settings');

  // --- Change password state ---
  const changePassword = useAction(changePasswordAction);
  const [currentPwd, setCurrentPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [pwdClientError, setPwdClientError] = useState<string | null>(null);
  const [pwdSuccess, setPwdSuccess] = useState<string | null>(null);

  // --- Change email state ---
  const changeEmail = useAction(changeEmailAction);
  const [newEmail, setNewEmail] = useState('');
  const [emailPwd, setEmailPwd] = useState('');
  const [emailClientError, setEmailClientError] = useState<string | null>(null);
  const [emailSuccess, setEmailSuccess] = useState<string | null>(null);

  // Password action result
  useEffect(() => {
    const result = changePassword.result.data;
    if (!result) return;
    if (result.ok) {
      setPwdSuccess(t('security.password.success'));
      setCurrentPwd('');
      setNewPwd('');
      setConfirmPwd('');
    }
  }, [changePassword.result.data, t]);

  // Email action result
  useEffect(() => {
    const result = changeEmail.result.data;
    if (!result) return;
    if (result.ok) {
      setEmailSuccess(t('security.email.success'));
      setNewEmail('');
      setEmailPwd('');
    }
  }, [changeEmail.result.data, t]);

  const pwdActionError = (() => {
    const result = changePassword.result.data;
    if (!result || result.ok) return null;
    const code = result.errorCode;
    const key = isPasswordErrorCode(code) ? PASSWORD_ERROR_KEY[code] : null;
    return key ? t(`security.password.errors.${key}`) : t('security.password.errors.generic');
  })();

  const pwdValidationError = changePassword.result.validationErrors
    ? t('security.password.errors.generic')
    : null;

  const emailActionError = (() => {
    const result = changeEmail.result.data;
    if (!result || result.ok) return null;
    const code = result.errorCode;
    const key = isEmailErrorCode(code) ? EMAIL_ERROR_KEY[code] : null;
    return key ? t(`security.email.errors.${key}`) : t('security.email.errors.generic');
  })();

  const emailValidationError = changeEmail.result.validationErrors
    ? t('security.email.errors.generic')
    : null;

  function onPasswordSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPwdClientError(null);
    setPwdSuccess(null);

    if (!checkPasswordStrength(newPwd).allValid) {
      setPwdClientError(t('security.password.criteriaHint'));
      return;
    }

    if (newPwd !== confirmPwd) {
      setPwdClientError(t('security.password.errors.mismatch'));
      return;
    }

    if (newPwd === currentPwd) {
      setPwdClientError(t('security.password.errors.same_as_current'));
      return;
    }

    changePassword.execute({
      currentPassword: currentPwd,
      newPassword: newPwd,
      confirmPassword: confirmPwd,
    });
  }

  function onEmailSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEmailClientError(null);
    setEmailSuccess(null);

    if (!newEmail.includes('@')) {
      setEmailClientError(t('security.email.errors.generic'));
      return;
    }

    changeEmail.execute({ newEmail: newEmail.trim(), currentPassword: emailPwd });
  }

  const pwdError = pwdClientError ?? pwdActionError ?? pwdValidationError;
  const emailError = emailClientError ?? emailActionError ?? emailValidationError;

  return (
    <div className="max-w-2xl space-y-6">
      <h2 className="text-xl font-semibold">{t('security.title')}</h2>

      {/* Change password */}
      <Card padding="lg">
        <h3 className="mb-5 text-base font-semibold">{t('security.password.title')}</h3>
        <form className="space-y-4" onSubmit={onPasswordSubmit}>
          <div className="space-y-2">
            <Label htmlFor="sec-current-pwd">{t('security.password.currentLabel')}</Label>
            <PasswordField
              autoComplete="current-password"
              hideLabel={t('security.password.hidePassword')}
              id="sec-current-pwd"
              onChange={(e) => setCurrentPwd(e.target.value)}
              required
              showLabel={t('security.password.showPassword')}
              value={currentPwd}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="sec-new-pwd">{t('security.password.newLabel')}</Label>
            <PasswordField
              autoComplete="new-password"
              hideLabel={t('security.password.hidePassword')}
              id="sec-new-pwd"
              onChange={(e) => setNewPwd(e.target.value)}
              required
              showLabel={t('security.password.showPassword')}
              value={newPwd}
            />
            <p className="text-xs text-muted">{t('security.password.criteriaHint')}</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="sec-confirm-pwd">{t('security.password.confirmLabel')}</Label>
            <PasswordField
              autoComplete="new-password"
              hideLabel={t('security.password.hidePassword')}
              id="sec-confirm-pwd"
              onChange={(e) => setConfirmPwd(e.target.value)}
              required
              showLabel={t('security.password.showPassword')}
              value={confirmPwd}
            />
          </div>

          {pwdSuccess ? (
            <output className="block rounded-lg border border-success/30 bg-canvas p-3 text-sm text-success">
              {pwdSuccess}
            </output>
          ) : null}

          {pwdError ? (
            <p className="text-sm text-danger" role="alert">
              {pwdError}
            </p>
          ) : null}

          <Button disabled={changePassword.isExecuting} type="submit">
            {t('security.password.save')}
          </Button>
        </form>
      </Card>

      {/* Change email */}
      <Card padding="lg">
        <h3 className="mb-5 text-base font-semibold">{t('security.email.title')}</h3>
        <form className="space-y-4" onSubmit={onEmailSubmit}>
          <div className="space-y-2">
            <Label htmlFor="sec-current-email">{t('security.email.currentLabel')}</Label>
            <Input id="sec-current-email" readOnly value={currentEmail} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="sec-new-email">{t('security.email.newLabel')}</Label>
            <Input
              autoComplete="email"
              id="sec-new-email"
              onChange={(e) => setNewEmail(e.target.value)}
              required
              type="email"
              value={newEmail}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="sec-email-pwd">{t('security.email.passwordLabel')}</Label>
            <PasswordField
              autoComplete="current-password"
              hideLabel={t('security.password.hidePassword')}
              id="sec-email-pwd"
              onChange={(e) => setEmailPwd(e.target.value)}
              required
              showLabel={t('security.password.showPassword')}
              value={emailPwd}
            />
          </div>

          {emailSuccess ? (
            <output className="block rounded-lg border border-success/30 bg-canvas p-3 text-sm text-success">
              {emailSuccess}
            </output>
          ) : null}

          {emailError ? (
            <p className="text-sm text-danger" role="alert">
              {emailError}
            </p>
          ) : null}

          <Button disabled={changeEmail.isExecuting} type="submit">
            {t('security.email.save')}
          </Button>
        </form>
      </Card>
    </div>
  );
}
