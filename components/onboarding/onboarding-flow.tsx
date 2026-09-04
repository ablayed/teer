'use client';

import { BrandPanel } from '@/components/auth/brand-panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { completeOnboardingAction } from '@/lib/actions/merchant';
import { cn } from '@/lib/utils';
import { CheckCircle2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useMemo, useState } from 'react';

type CountryCode = 'SN' | 'CI' | 'BJ' | 'TG' | 'BF' | 'ML';
type Step = 1 | 2;
type OnboardingErrorCode =
  | 'invalid_whatsapp'
  | 'merchant_not_found'
  | 'update_failed'
  | 'audit_failed';

const countryCodes = ['SN', 'CI', 'BJ', 'TG', 'BF', 'ML'] as const satisfies readonly CountryCode[];
const onboardingErrorCodes = [
  'invalid_whatsapp',
  'merchant_not_found',
  'update_failed',
  'audit_failed',
] as const satisfies readonly OnboardingErrorCode[];

function isOnboardingErrorCode(errorCode: string): errorCode is OnboardingErrorCode {
  return onboardingErrorCodes.includes(errorCode as OnboardingErrorCode);
}

export function OnboardingFlow() {
  const t = useTranslations('onboarding');
  const router = useRouter();
  const completeOnboarding = useAction(completeOnboardingAction);

  const [step, setStep] = useState<Step>(1);
  const [shopName, setShopName] = useState('');
  const [countryCode, setCountryCode] = useState<CountryCode>('SN');
  const [ownerFullName, setOwnerFullName] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [clientError, setClientError] = useState<string | null>(null);
  const [step1Saved, setStep1Saved] = useState(false);
  const [welcomeVisible, setWelcomeVisible] = useState(false);

  const shopNameIsValid = shopName.trim().length >= 2;
  const ownerNameIsValid = ownerFullName.trim().length >= 2;

  const actionError = useMemo(() => {
    const result = completeOnboarding.result.data;
    if (!result || result.ok) return null;
    return isOnboardingErrorCode(result.errorCode)
      ? t(`errors.${result.errorCode}`)
      : t('errors.generic');
  }, [completeOnboarding.result.data, t]);

  const validationError = completeOnboarding.result.validationErrors ? t('errors.generic') : null;
  const errorMessage = clientError ?? actionError ?? validationError;

  useEffect(() => {
    if (completeOnboarding.result.data?.ok) {
      setWelcomeVisible(true);
    }
  }, [completeOnboarding.result.data]);

  function goToSecondStep() {
    setClientError(null);
    if (!shopNameIsValid) {
      setClientError(t('errors.shopName'));
      return;
    }
    setStep1Saved(true);
    setStep(2);
    setTimeout(() => setStep1Saved(false), 3000);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setClientError(null);

    if (!shopNameIsValid) {
      setClientError(t('errors.shopName'));
      setStep(1);
      return;
    }
    if (!ownerNameIsValid) {
      setClientError(t('errors.ownerFullName'));
      return;
    }

    completeOnboarding.execute({
      shopName: shopName.trim(),
      countryCode,
      ownerFullName: ownerFullName.trim(),
      whatsapp: whatsapp.trim() || undefined,
    });
  }

  const firstName = ownerFullName.trim().split(' ')[0] || ownerFullName.trim();

  if (welcomeVisible) {
    return (
      <main className="flex min-h-dvh flex-col md:flex-row">
        <BrandPanel />
        <div className="flex flex-1 flex-col items-center justify-center bg-surface px-5 py-12 md:bg-canvas md:px-12">
          <section
            aria-label={t('ariaWelcome')}
            className="auth-step-enter w-full max-w-[420px] space-y-5 md:rounded-2xl md:border md:border-border md:bg-surface md:p-8 md:shadow-warm-2"
          >
            <div className="flex items-start gap-3">
              <span className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-success/10 text-success">
                <CheckCircle2 aria-hidden="true" className="size-5" />
              </span>
              <h1 className="font-display text-3xl tracking-tight">
                {t('welcome.title', { name: firstName })}
              </h1>
            </div>
            <p className="text-sm leading-6 text-muted">{t('welcome.subtitle')}</p>
            <p className="text-sm text-muted">{t('welcome.checklist')}</p>
            <Button
              className="min-h-12 w-full"
              onClick={() => router.push('/tableau')}
              type="button"
            >
              {t('welcome.cta')}
            </Button>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh flex-col md:flex-row">
      <BrandPanel />
      <div className="flex flex-1 flex-col items-center justify-center bg-surface px-5 py-10 md:bg-canvas md:px-12">
        <section
          aria-label={t('ariaLabel')}
          className="w-full max-w-[480px] md:rounded-2xl md:border md:border-border md:bg-surface md:p-8 md:shadow-warm-2"
        >
          {/* Progress indicator */}
          <div className="mb-6 space-y-2">
            <p className="text-xs font-medium text-muted">{t('stepIndicator', { step })}</p>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-canvas">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
                style={{ width: step === 1 ? '50%' : '100%' }}
              />
            </div>
          </div>

          {/* Step-save confirmation (step 2 only, auto-dismisses) */}
          {step1Saved ? (
            <output className="mb-4 block text-sm text-success">{t('stepSaved')}</output>
          ) : null}

          <form className="space-y-6" onSubmit={onSubmit}>
            <div className="auth-step-enter space-y-6" key={step}>
              {step === 1 ? (
                <>
                  <div className="space-y-1">
                    <h1 className="font-display text-3xl tracking-tight">{t('step1.title')}</h1>
                    <p className="text-sm leading-6 text-muted">{t('step1.subtitle')}</p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="shopName">{t('fields.shopName')}</Label>
                    <Input
                      autoComplete="organization"
                      id="shopName"
                      name="shopName"
                      onChange={(event) => setShopName(event.target.value)}
                      required
                      value={shopName}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="countryCode">{t('fields.country')}</Label>
                    <select
                      className="h-12 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text shadow-1 transition focus:border-accent focus:outline-none"
                      id="countryCode"
                      name="countryCode"
                      onChange={(event) => setCountryCode(event.target.value as CountryCode)}
                      value={countryCode}
                    >
                      {countryCodes.map((code) => (
                        <option key={code} value={code}>
                          {t(`countries.${code}`)}
                        </option>
                      ))}
                    </select>
                  </div>

                  {errorMessage ? (
                    <p className="text-sm text-danger" role="alert">
                      {errorMessage}
                    </p>
                  ) : null}

                  <p className="text-xs text-muted">{t('reassurance')}</p>

                  <Button className="min-h-12 w-full" onClick={goToSecondStep} type="button">
                    {t('actions.continue')}
                  </Button>
                </>
              ) : (
                <>
                  <div className="space-y-1">
                    <h1 className="font-display text-3xl tracking-tight">{t('step2.title')}</h1>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="ownerFullName">{t('fields.ownerFullName')}</Label>
                    <Input
                      autoComplete="name"
                      id="ownerFullName"
                      name="ownerFullName"
                      onChange={(event) => setOwnerFullName(event.target.value)}
                      required
                      value={ownerFullName}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="whatsapp">{t('fields.whatsapp')}</Label>
                    <Input
                      autoComplete="tel"
                      id="whatsapp"
                      name="whatsapp"
                      onChange={(event) => setWhatsapp(event.target.value)}
                      placeholder={t('fields.whatsappPlaceholder')}
                      type="tel"
                      value={whatsapp}
                    />
                    <p className="text-xs text-muted">{t('fields.whatsappHint')}</p>
                  </div>

                  {errorMessage ? (
                    <p className="text-sm text-danger" role="alert">
                      {errorMessage}
                    </p>
                  ) : null}

                  <p className="text-xs text-muted">{t('reassurance')}</p>

                  <div className="grid gap-3 sm:grid-cols-[1fr_1.2fr]">
                    <Button
                      className="min-h-12"
                      onClick={() => {
                        setClientError(null);
                        setStep(1);
                      }}
                      type="button"
                      variant="ghost"
                    >
                      {t('actions.back')}
                    </Button>
                    <Button
                      aria-busy={completeOnboarding.isExecuting}
                      className="min-h-12"
                      disabled={completeOnboarding.isExecuting}
                      type="submit"
                    >
                      {completeOnboarding.isExecuting
                        ? t('actions.finish_loading')
                        : t('actions.finish')}
                    </Button>
                  </div>
                </>
              )}
            </div>
          </form>
        </section>
      </div>
    </main>
  );
}
