'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Wordmark } from '@/components/wordmark';
import { completeOnboardingAction } from '@/lib/actions/merchant';
import { cn } from '@/lib/utils';
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

  const shopNameIsValid = shopName.trim().length >= 2;
  const ownerNameIsValid = ownerFullName.trim().length >= 2;

  const actionError = useMemo(() => {
    const result = completeOnboarding.result.data;

    if (!result || result.ok) {
      return null;
    }

    return isOnboardingErrorCode(result.errorCode)
      ? t(`errors.${result.errorCode}`)
      : t('errors.generic');
  }, [completeOnboarding.result.data, t]);

  const validationError = completeOnboarding.result.validationErrors ? t('errors.generic') : null;

  useEffect(() => {
    if (completeOnboarding.result.data?.ok) {
      router.push('/tableau');
      router.refresh();
    }
  }, [completeOnboarding.result.data, router]);

  function goToSecondStep() {
    setClientError(null);

    if (!shopNameIsValid) {
      setClientError(t('errors.shopName'));
      return;
    }

    setStep(2);
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

  const errorMessage = clientError ?? actionError ?? validationError;

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10" id="main">
      <section
        aria-label={t('ariaLabel')}
        className="w-full max-w-[480px] rounded-2xl border border-border bg-surface p-6 shadow-2 md:p-8"
      >
        <div className="mb-8 flex flex-col items-center gap-5">
          <Wordmark size="md" />
          <div aria-label={t('stepIndicator', { step })} className="flex items-center gap-2">
            {[1, 2].map((item) => (
              <span
                aria-current={step === item ? 'step' : undefined}
                className={cn(
                  'h-2.5 w-2.5 rounded-full transition',
                  step === item ? 'bg-accent' : 'bg-border',
                )}
                key={item}
              />
            ))}
          </div>
        </div>

        <form className="space-y-6" onSubmit={onSubmit}>
          {step === 1 ? (
            <div className="space-y-6">
              <div className="space-y-2">
                <h1 className="font-display text-4xl leading-tight">{t('step1.title')}</h1>
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
                  className="h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text shadow-1 transition focus:border-accent"
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

              <Button className="min-h-12 w-full" onClick={goToSecondStep} type="button">
                {t('actions.continue')}
              </Button>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="space-y-2">
                <h1 className="font-display text-4xl leading-tight">{t('step2.title')}</h1>
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
                <p className="text-sm text-muted">{t('fields.whatsappHint')}</p>
              </div>

              {errorMessage ? (
                <p className="text-sm text-danger" role="alert">
                  {errorMessage}
                </p>
              ) : null}

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
                  className="min-h-12"
                  disabled={completeOnboarding.isExecuting}
                  type="submit"
                >
                  {t('actions.finish')}
                </Button>
              </div>
            </div>
          )}
        </form>
      </section>
    </main>
  );
}
