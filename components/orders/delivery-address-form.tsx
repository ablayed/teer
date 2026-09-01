'use client';

import { upsertOrderDeliveryAddressAction } from '@/lib/actions/address';
import type { DeliveryAddress } from '@/lib/actions/orders';
import { toSenegalNationalDigits } from '@/lib/address/phone-sn';
import { cn } from '@/lib/utils';
import { LocateFixed } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import { useEffect, useState } from 'react';

type DeliveryAddressFormProps = {
  fallbackPhone?: string | null;
  fallbackQuartier?: string | null;
  fallbackVille?: string | null;
  initialAddress: DeliveryAddress | null;
  orderId: string;
};

type Feedback = {
  message: string;
  tone: 'error' | 'success';
};

function nationalInput(value: string): string {
  let digits = value.replace(/\D/g, '');

  if (digits.startsWith('221')) {
    digits = digits.slice(3);
  }

  if (digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  return digits.slice(0, 9);
}

function formValue(value: string | null | undefined): string {
  return value ?? '';
}

function addressErrorMessage(
  t: ReturnType<typeof useTranslations<'orders.address'>>,
  errorCode: string | undefined,
): string {
  switch (errorCode) {
    case 'invalid_phone':
      return t('errors.invalidPhone');
    case 'order_not_found':
      return t('errors.orderNotFound');
    case 'audit_failed':
      return t('errors.auditFailed');
    default:
      return t('errors.generic');
  }
}

export function DeliveryAddressForm({
  fallbackPhone,
  fallbackQuartier,
  fallbackVille,
  initialAddress,
  orderId,
}: DeliveryAddressFormProps) {
  const t = useTranslations('orders.address');
  const saveAddress = useAction(upsertOrderDeliveryAddressAction);
  const [quartierCommune, setQuartierCommune] = useState('');
  const [ville, setVille] = useState('Dakar');
  const [repere, setRepere] = useState('');
  const [indicationsAcces, setIndicationsAcces] = useState('');
  const [telephonePrincipal, setTelephonePrincipal] = useState('');
  const [telephoneAlternatif, setTelephoneAlternatif] = useState('');
  const [gps, setGps] = useState<{ lat: number | null; lng: number | null }>({
    lat: null,
    lng: null,
  });
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);

  useEffect(() => {
    setQuartierCommune(formValue(initialAddress?.quartier_commune ?? fallbackQuartier));
    setVille(formValue(initialAddress?.ville ?? fallbackVille) || 'Dakar');
    setRepere(formValue(initialAddress?.repere));
    setIndicationsAcces(formValue(initialAddress?.indications_acces));
    setTelephonePrincipal(
      toSenegalNationalDigits(initialAddress?.telephone_principal ?? fallbackPhone),
    );
    setTelephoneAlternatif(toSenegalNationalDigits(initialAddress?.telephone_alternatif));
    setGps({
      lat: initialAddress?.gps_lat ?? null,
      lng: initialAddress?.gps_lng ?? null,
    });
  }, [fallbackPhone, fallbackQuartier, fallbackVille, initialAddress]);

  function fillGps() {
    setFeedback(null);

    if (!navigator.geolocation) {
      setFeedback({ tone: 'error', message: t('gpsUnavailable') });
      return;
    }

    setGpsLoading(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setGps({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        });
        setGpsLoading(false);
        setFeedback({ tone: 'success', message: t('gpsSaved') });
      },
      () => {
        setGpsLoading(false);
        setFeedback({ tone: 'error', message: t('gpsDenied') });
      },
      { enableHighAccuracy: true, maximumAge: 60_000, timeout: 10_000 },
    );
  }

  async function submit() {
    setFeedback(null);

    if (!quartierCommune.trim()) {
      setFeedback({ tone: 'error', message: t('errors.quartierRequired') });
      return;
    }

    if (!/^\d{9}$/.test(telephonePrincipal)) {
      setFeedback({ tone: 'error', message: t('errors.invalidPhone') });
      return;
    }

    if (telephoneAlternatif && !/^\d{9}$/.test(telephoneAlternatif)) {
      setFeedback({ tone: 'error', message: t('errors.invalidAltPhone') });
      return;
    }

    const result = await saveAddress.executeAsync({
      orderId,
      quartierCommune: quartierCommune.trim(),
      ville: ville.trim() || 'Dakar',
      repere: repere.trim() || undefined,
      indicationsAcces: indicationsAcces.trim() || undefined,
      gpsLat: gps.lat,
      gpsLng: gps.lng,
      telephonePrincipal: `+221${telephonePrincipal}`,
      telephoneAlternatif: telephoneAlternatif ? `+221${telephoneAlternatif}` : undefined,
    });

    if (result?.data?.ok) {
      setFeedback({ tone: 'success', message: t('saved') });
      return;
    }

    setFeedback({
      tone: 'error',
      message: addressErrorMessage(t, result?.data?.errorCode),
    });
  }

  return (
    <div className="space-y-4 rounded-lg border border-border bg-surface p-4 shadow-1">
      <div>
        <h3 className="text-sm font-semibold text-text">{t('title')}</h3>
        <p className="mt-1 text-xs leading-5 text-muted">{t('description')}</p>
      </div>

      <div className="grid gap-4">
        <label className="grid gap-1.5 text-sm font-medium text-text">
          {t('fields.quartierCommune')}
          <input
            className="min-h-12 rounded-lg border border-border bg-surface px-3 text-sm text-text shadow-1 outline-none transition placeholder:text-muted focus:border-accent"
            onChange={(event) => setQuartierCommune(event.target.value)}
            required
            type="text"
            value={quartierCommune}
          />
        </label>

        <label className="grid gap-1.5 text-sm font-medium text-text">
          {t('fields.ville')}
          <input
            className="min-h-12 rounded-lg border border-border bg-surface px-3 text-sm text-text shadow-1 outline-none transition placeholder:text-muted focus:border-accent"
            onChange={(event) => setVille(event.target.value)}
            type="text"
            value={ville}
          />
        </label>

        <label className="grid gap-1.5 text-sm font-medium text-text">
          {t('fields.repere')}
          <input
            className="min-h-12 rounded-lg border border-border bg-surface px-3 text-sm text-text shadow-1 outline-none transition placeholder:text-muted focus:border-accent"
            onChange={(event) => setRepere(event.target.value)}
            placeholder={t('placeholders.repere')}
            type="text"
            value={repere}
          />
        </label>

        <label className="grid gap-1.5 text-sm font-medium text-text">
          {t('fields.indicationsAcces')}
          <textarea
            className="min-h-24 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text shadow-1 outline-none transition placeholder:text-muted focus:border-accent"
            onChange={(event) => setIndicationsAcces(event.target.value)}
            value={indicationsAcces}
          />
        </label>

        <label className="grid gap-1.5 text-sm font-medium text-text">
          {t('fields.telephonePrincipal')}
          <span className="flex min-h-12 overflow-hidden rounded-lg border border-border bg-surface shadow-1 focus-within:border-accent">
            <span className="inline-flex items-center border-border border-r bg-canvas px-3 font-mono text-sm text-muted">
              +221
            </span>
            <input
              className="min-w-0 flex-1 bg-transparent px-3 font-mono text-sm text-text tabular-nums outline-none placeholder:text-muted"
              inputMode="numeric"
              maxLength={9}
              onChange={(event) => setTelephonePrincipal(nationalInput(event.target.value))}
              pattern="[0-9]*"
              type="text"
              value={telephonePrincipal}
            />
          </span>
        </label>

        <label className="grid gap-1.5 text-sm font-medium text-text">
          {t('fields.telephoneAlternatif')}
          <span className="flex min-h-12 overflow-hidden rounded-lg border border-border bg-surface shadow-1 focus-within:border-accent">
            <span className="inline-flex items-center border-border border-r bg-canvas px-3 font-mono text-sm text-muted">
              +221
            </span>
            <input
              className="min-w-0 flex-1 bg-transparent px-3 font-mono text-sm text-text tabular-nums outline-none placeholder:text-muted"
              inputMode="numeric"
              maxLength={9}
              onChange={(event) => setTelephoneAlternatif(nationalInput(event.target.value))}
              pattern="[0-9]*"
              type="text"
              value={telephoneAlternatif}
            />
          </span>
        </label>

        <button
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md border border-border bg-surface px-4 text-sm font-medium text-text shadow-1 transition hover:bg-canvas disabled:opacity-50"
          disabled={gpsLoading}
          onClick={fillGps}
          type="button"
        >
          <LocateFixed aria-hidden="true" className="size-4" />
          {gpsLoading ? t('gpsLoading') : t('gpsButton')}
        </button>

        {gps.lat !== null && gps.lng !== null ? (
          <p className="font-mono text-xs text-muted tabular-nums">
            {t('gpsValue', {
              lat: gps.lat.toFixed(5),
              lng: gps.lng.toFixed(5),
            })}
          </p>
        ) : null}
      </div>

      {feedback ? (
        <output
          className={cn(
            'block rounded-lg border p-3 text-sm font-medium',
            feedback.tone === 'success'
              ? 'border-success/30 bg-success-subtle text-success'
              : 'border-danger/30 bg-danger-subtle text-danger',
          )}
        >
          {feedback.message}
        </output>
      ) : null}

      <button
        className="inline-flex min-h-12 w-full items-center justify-center rounded-md bg-accent px-5 font-medium text-accent-ink transition hover:bg-accent-hover disabled:opacity-50"
        disabled={saveAddress.isExecuting}
        onClick={submit}
        type="button"
      >
        {saveAddress.isExecuting ? t('saving') : t('save')}
      </button>
    </div>
  );
}
