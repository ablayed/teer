'use client';

import { SettingsSecurity } from '@/components/settings/settings-security';
import { SettingsShops } from '@/components/settings/settings-shops';
import { SettingsTeam } from '@/components/settings/settings-team';
import { SignOutButton } from '@/components/sign-out-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { updateMerchantProfileAction } from '@/lib/actions/merchant';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import { type FormEvent, useEffect, useMemo, useState } from 'react';

type CountryCode = 'SN' | 'CI' | 'BJ' | 'TG' | 'BF' | 'ML';
type SettingsTab = 'profile' | 'team' | 'shops' | 'security' | 'billing';
type SettingsErrorCode =
  | 'invalid_whatsapp'
  | 'merchant_not_found'
  | 'update_failed'
  | 'audit_failed';

type SettingsProfileProps = {
  countryCode: string;
  currentRole: string;
  email: string;
  ownerFullName: string;
  shopName: string;
  whatsapp: string;
};

const countryCodes = ['SN', 'CI', 'BJ', 'TG', 'BF', 'ML'] as const satisfies readonly CountryCode[];
const settingsTabs = [
  'profile',
  'team',
  'shops',
  'security',
  'billing',
] as const satisfies readonly SettingsTab[];
const settingsErrorCodes = [
  'invalid_whatsapp',
  'merchant_not_found',
  'update_failed',
  'audit_failed',
] as const satisfies readonly SettingsErrorCode[];

function isCountryCode(value: string): value is CountryCode {
  return countryCodes.includes(value as CountryCode);
}

function isSettingsErrorCode(errorCode: string): errorCode is SettingsErrorCode {
  return settingsErrorCodes.includes(errorCode as SettingsErrorCode);
}

export function SettingsProfile({
  countryCode,
  currentRole,
  email,
  ownerFullName,
  shopName,
  whatsapp,
}: SettingsProfileProps) {
  const t = useTranslations('settings');
  const router = useRouter();
  const updateProfile = useAction(updateMerchantProfileAction);
  // `tab` fusionne en place (nuqs) : ne touche jamais les autres query params
  // (ex. `connected`/`error` du retour OAuth Shopify sur l'onglet Boutiques).
  const [tabParam, setTabParam] = useQueryState(
    'tab',
    parseAsStringLiteral(settingsTabs).withOptions({ history: 'push', scroll: false }),
  );
  const activeTab = tabParam ?? 'profile';
  const setActiveTab = setTabParam;
  const [currentShopName, setCurrentShopName] = useState(shopName);
  const [currentCountryCode, setCurrentCountryCode] = useState<CountryCode>(
    isCountryCode(countryCode) ? countryCode : 'SN',
  );
  const [currentOwnerFullName, setCurrentOwnerFullName] = useState(ownerFullName);
  const [currentWhatsapp, setCurrentWhatsapp] = useState(whatsapp);
  const [clientError, setClientError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const actionError = useMemo(() => {
    const result = updateProfile.result.data;

    if (!result || result.ok) {
      return null;
    }

    return isSettingsErrorCode(result.errorCode)
      ? t(`errors.${result.errorCode}`)
      : t('errors.generic');
  }, [t, updateProfile.result.data]);

  const validationError = updateProfile.result.validationErrors ? t('errors.generic') : null;

  useEffect(() => {
    if (updateProfile.result.data?.ok) {
      setSuccessMessage(t('profile.success'));
      router.refresh();
    }
  }, [router, t, updateProfile.result.data]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setClientError(null);
    setSuccessMessage(null);

    if (currentShopName.trim().length < 2) {
      setClientError(t('errors.shopName'));
      return;
    }

    if (currentOwnerFullName.trim().length < 2) {
      setClientError(t('errors.ownerFullName'));
      return;
    }

    updateProfile.execute({
      shopName: currentShopName.trim(),
      countryCode: currentCountryCode,
      ownerFullName: currentOwnerFullName.trim(),
      whatsapp: currentWhatsapp.trim() || undefined,
    });
  }

  const errorMessage = clientError ?? actionError ?? validationError;

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="font-display text-4xl md:text-5xl">{t('title')}</h1>
      </div>

      <div
        aria-label={t('tabs.ariaLabel')}
        className="flex gap-2 overflow-x-auto border-b border-border"
        role="tablist"
      >
        {settingsTabs.map((tab) => (
          <button
            aria-controls={`settings-panel-${tab}`}
            aria-selected={activeTab === tab}
            className={cn(
              'min-h-12 whitespace-nowrap border-b-2 px-3 text-sm font-medium transition',
              activeTab === tab
                ? 'border-accent text-text'
                : 'border-transparent text-muted hover:text-text',
            )}
            id={`settings-tab-${tab}`}
            key={tab}
            onClick={() => setActiveTab(tab)}
            role="tab"
            type="button"
          >
            {t(`tabs.${tab}`)}
          </button>
        ))}
      </div>

      {activeTab === 'profile' ? (
        <section
          aria-labelledby="settings-tab-profile"
          className="max-w-2xl space-y-8"
          id="settings-panel-profile"
          role="tabpanel"
        >
          <form className="space-y-6" onSubmit={onSubmit}>
            <div className="grid gap-5 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="settings-shop-name">{t('profile.fields.shopName')}</Label>
                <Input
                  id="settings-shop-name"
                  name="shopName"
                  onChange={(event) => setCurrentShopName(event.target.value)}
                  required
                  value={currentShopName}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="settings-country">{t('profile.fields.country')}</Label>
                <select
                  className="h-12 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text shadow-1 transition focus:border-accent"
                  id="settings-country"
                  name="countryCode"
                  onChange={(event) => setCurrentCountryCode(event.target.value as CountryCode)}
                  value={currentCountryCode}
                >
                  {countryCodes.map((code) => (
                    <option key={code} value={code}>
                      {t(`countries.${code}`)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="settings-owner-name">{t('profile.fields.ownerFullName')}</Label>
                <Input
                  autoComplete="name"
                  id="settings-owner-name"
                  name="ownerFullName"
                  onChange={(event) => setCurrentOwnerFullName(event.target.value)}
                  required
                  value={currentOwnerFullName}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="settings-whatsapp">{t('profile.fields.whatsapp')}</Label>
                <Input
                  autoComplete="tel"
                  id="settings-whatsapp"
                  name="whatsapp"
                  onChange={(event) => setCurrentWhatsapp(event.target.value)}
                  placeholder={t('profile.fields.whatsappPlaceholder')}
                  type="tel"
                  value={currentWhatsapp}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="settings-email">{t('profile.fields.email')}</Label>
                <Input id="settings-email" readOnly value={email} />
              </div>

              <div className="space-y-2">
                <span className="text-sm font-medium text-text">{t('profile.fields.plan')}</span>
                <div>
                  <span className="inline-flex min-h-8 items-center rounded-full border border-border bg-canvas px-3 text-sm font-medium text-text">
                    {t('profile.planDiscovery')}
                  </span>
                </div>
              </div>
            </div>

            {successMessage ? (
              <output className="block rounded-lg border border-success/30 bg-canvas p-3 text-sm text-success">
                {successMessage}
              </output>
            ) : null}

            {errorMessage ? (
              <p className="text-sm text-danger" role="alert">
                {errorMessage}
              </p>
            ) : null}

            <Button disabled={updateProfile.isExecuting} type="submit">
              {t('profile.save')}
            </Button>
          </form>

          <section className="border-t border-border pt-6">
            <div className="space-y-3">
              <h2 className="text-lg font-semibold">{t('signOut.title')}</h2>
              <SignOutButton />
            </div>
          </section>
        </section>
      ) : activeTab === 'team' ? (
        <section
          aria-labelledby="settings-tab-team"
          className="max-w-5xl"
          id="settings-panel-team"
          role="tabpanel"
        >
          <SettingsTeam currentRole={currentRole} orgName={currentShopName} />
        </section>
      ) : activeTab === 'shops' ? (
        <section
          aria-labelledby="settings-tab-shops"
          className="max-w-5xl"
          id="settings-panel-shops"
          role="tabpanel"
        >
          <SettingsShops currentRole={currentRole} />
        </section>
      ) : activeTab === 'security' ? (
        <section
          aria-labelledby="settings-tab-security"
          id="settings-panel-security"
          role="tabpanel"
        >
          <SettingsSecurity currentEmail={email} />
        </section>
      ) : (
        <section
          aria-labelledby={`settings-tab-${activeTab}`}
          className="max-w-2xl rounded-lg border border-border bg-surface p-6"
          id={`settings-panel-${activeTab}`}
          role="tabpanel"
        >
          <h2 className="text-xl font-semibold">{t(`tabs.${activeTab}`)}</h2>
          <p className="mt-2 text-muted">{t('placeholder')}</p>
        </section>
      )}
    </div>
  );
}
