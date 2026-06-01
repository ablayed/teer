'use client';

import { updateMerchantSettingsAction } from '@/lib/actions/finance-settings';
import { formatMoney } from '@/lib/format/fcfa';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';

export type FinanceSettingsValues = {
  cogsKnown: boolean;
  defaultDeliveryCostMinor: number;
  freeMoneyFeeBps: number;
  merchantLevyBps: number;
  orangeMoneyFeeBps: number;
  transferTaxBps: number;
  transferTaxCapMinor: number;
  waveFeeBps: number;
};

type FinanceSettingsPanelProps = {
  currentRole: string;
  settings: FinanceSettingsValues;
};

function bpsToPercentLabel(value: number): string {
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(value / 100)} %`;
}

export function FinanceSettingsPanel({ currentRole, settings }: FinanceSettingsPanelProps) {
  const t = useTranslations('finance.settings');
  const router = useRouter();
  const updateSettings = useAction(updateMerchantSettingsAction);
  const readOnly = currentRole !== 'owner';
  const [merchantLevyBps, setMerchantLevyBps] = useState(settings.merchantLevyBps);
  const [transferTaxBps, setTransferTaxBps] = useState(settings.transferTaxBps);
  const [transferTaxCapMinor, setTransferTaxCapMinor] = useState(settings.transferTaxCapMinor);
  const [waveFeeBps, setWaveFeeBps] = useState(settings.waveFeeBps);
  const [orangeMoneyFeeBps, setOrangeMoneyFeeBps] = useState(settings.orangeMoneyFeeBps);
  const [freeMoneyFeeBps, setFreeMoneyFeeBps] = useState(settings.freeMoneyFeeBps);
  const [defaultDeliveryCostMinor, setDefaultDeliveryCostMinor] = useState(
    settings.defaultDeliveryCostMinor,
  );
  const [cogsKnown, setCogsKnown] = useState(settings.cogsKnown);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (updateSettings.result.data?.ok) {
      setNotice(t('success'));
      router.refresh();
    } else if (updateSettings.result.data?.ok === false) {
      setNotice(t('error'));
    }
  }, [router, t, updateSettings.result.data]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (readOnly) {
      return;
    }

    updateSettings.execute({
      cogsKnown,
      defaultDeliveryCostMinor,
      freeMoneyFeeBps,
      merchantLevyBps,
      orangeMoneyFeeBps,
      transferTaxBps,
      transferTaxCapMinor,
      waveFeeBps,
    });
  }

  function bpsInput({
    label,
    onChange,
    value,
  }: {
    label: string;
    onChange: (value: number) => void;
    value: number;
  }) {
    return (
      <label className="space-y-2">
        <span className="text-sm font-medium">{label}</span>
        <div className="flex items-center gap-2">
          <input
            className="h-11 w-full rounded-md border border-border bg-canvas px-3 font-mono tabular-nums disabled:text-muted"
            disabled={readOnly}
            max={10_000}
            min={0}
            onChange={(event) => onChange(Number(event.target.value))}
            type="number"
            value={value}
          />
          <span className="w-20 text-right font-mono text-sm tabular-nums text-muted">
            {bpsToPercentLabel(value)}
          </span>
        </div>
      </label>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-5 shadow-1" id="frais">
      <div className="max-w-3xl space-y-2">
        <h2 className="text-xl font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted">{readOnly ? t('readOnly') : t('description')}</p>
      </div>

      <form className="mt-5 grid gap-4 md:grid-cols-2" onSubmit={submit}>
        {bpsInput({
          label: t('merchantLevy'),
          onChange: setMerchantLevyBps,
          value: merchantLevyBps,
        })}
        {bpsInput({
          label: t('transferTax'),
          onChange: setTransferTaxBps,
          value: transferTaxBps,
        })}
        <label className="space-y-2">
          <span className="text-sm font-medium">{t('transferTaxCap')}</span>
          <input
            className="h-11 w-full rounded-md border border-border bg-canvas px-3 font-mono tabular-nums disabled:text-muted"
            disabled={readOnly}
            min={0}
            onChange={(event) => setTransferTaxCapMinor(Number(event.target.value))}
            type="number"
            value={transferTaxCapMinor}
          />
          <span className="block text-xs text-muted">
            {formatMoney(transferTaxCapMinor, 'XOF')}
          </span>
        </label>
        {bpsInput({ label: t('waveFee'), onChange: setWaveFeeBps, value: waveFeeBps })}
        {bpsInput({
          label: t('orangeMoneyFee'),
          onChange: setOrangeMoneyFeeBps,
          value: orangeMoneyFeeBps,
        })}
        {bpsInput({
          label: t('freeMoneyFee'),
          onChange: setFreeMoneyFeeBps,
          value: freeMoneyFeeBps,
        })}
        <label className="space-y-2">
          <span className="text-sm font-medium">{t('deliveryCost')}</span>
          <input
            className="h-11 w-full rounded-md border border-border bg-canvas px-3 font-mono tabular-nums disabled:text-muted"
            disabled={readOnly}
            min={0}
            onChange={(event) => setDefaultDeliveryCostMinor(Number(event.target.value))}
            type="number"
            value={defaultDeliveryCostMinor}
          />
          <span className="block text-xs text-muted">
            {formatMoney(defaultDeliveryCostMinor, 'XOF')}
          </span>
        </label>
        <label className="flex min-h-11 items-center gap-3 rounded-md border border-border bg-canvas px-3">
          <input
            checked={cogsKnown}
            disabled={readOnly}
            onChange={(event) => setCogsKnown(event.target.checked)}
            type="checkbox"
          />
          <span className="text-sm font-medium">{t('cogsKnown')}</span>
        </label>

        <div className="md:col-span-2">
          <output className="mb-3 block text-sm text-muted">{notice}</output>
          {!readOnly ? (
            <button
              className="min-h-11 rounded-md bg-accent px-4 text-sm font-semibold text-text hover:bg-accent-hover disabled:opacity-60"
              disabled={updateSettings.isExecuting}
              type="submit"
            >
              {t('save')}
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
