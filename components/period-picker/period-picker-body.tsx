'use client';

import { Button } from '@/components/ui/button';
import type { ActivePeriod, PeriodPreset } from '@/lib/periods/date-range';
import { frenchDateInputToIso, isoDateToFrenchDateInput } from '@/lib/periods/french-date-input';
import { cn } from '@/lib/utils';
import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

type PeriodPickerBodyProps = {
  active: ActivePeriod;
  from: string | null;
  onApplied: () => void;
  onSelectCustom: (from: string, to: string) => void;
  onSelectPreset: (preset: PeriodPreset) => void;
  presets: readonly PeriodPreset[];
  to: string | null;
};

export function PeriodPickerBody({
  active,
  from,
  onApplied,
  onSelectCustom,
  onSelectPreset,
  presets,
  to,
}: PeriodPickerBodyProps) {
  const t = useTranslations('periodPicker');
  const [showCustom, setShowCustom] = useState(active === 'custom');
  const [draftFrom, setDraftFrom] = useState(isoDateToFrenchDateInput(from));
  const [draftTo, setDraftTo] = useState(isoDateToFrenchDateInput(to));

  const draftFromIso = frenchDateInputToIso(draftFrom);
  const draftToIso = frenchDateInputToIso(draftTo);
  const fromError = draftFrom && !draftFromIso ? t('invalidDate') : null;
  const toError = draftTo && !draftToIso ? t('invalidDate') : null;
  const rangeError =
    draftFromIso && draftToIso && draftFromIso > draftToIso ? t('invalidRange') : null;
  const canApply = Boolean(draftFromIso && draftToIso && !rangeError);

  const handleApplyCustom = () => {
    if (!draftFromIso || !draftToIso || rangeError) {
      return;
    }
    onSelectCustom(draftFromIso, draftToIso);
    onApplied();
  };

  const rowClass = (selected: boolean) =>
    cn(
      'flex min-h-11 w-full items-center justify-between rounded-md px-3 text-left text-sm font-medium transition',
      selected ? 'bg-accent-subtle text-accent-deep' : 'text-text hover:bg-canvas',
    );

  return (
    <div className="@container flex w-full flex-col">
      <fieldset className="m-0 flex min-w-0 flex-col border-0 p-2">
        <legend className="sr-only">{t('title')}</legend>
        {presets.map((preset) => {
          const selected = !showCustom && active === preset;
          return (
            <button
              aria-current={selected ? 'true' : undefined}
              className={rowClass(selected)}
              key={preset}
              onClick={() => {
                onSelectPreset(preset);
                onApplied();
              }}
              type="button"
            >
              {t(`presets.${preset}`)}
              {selected ? <Check aria-hidden="true" className="size-4" /> : null}
            </button>
          );
        })}
        <button
          aria-expanded={showCustom}
          className={rowClass(!showCustom && active === 'custom')}
          onClick={() => setShowCustom((value) => !value)}
          type="button"
        >
          {t('presets.custom')}
          {!showCustom && active === 'custom' ? (
            <Check aria-hidden="true" className="size-4" />
          ) : null}
        </button>
      </fieldset>

      {showCustom ? (
        <div className="border-t border-border p-3">
          <div className="flex flex-col gap-3 @sm:flex-row">
            <label className="flex flex-1 flex-col gap-1 text-xs font-medium text-muted">
              {t('from')}
              <input
                aria-describedby={
                  fromError
                    ? 'period-picker-from-error'
                    : rangeError
                      ? 'period-picker-range-error'
                      : undefined
                }
                aria-invalid={Boolean(fromError || rangeError)}
                className="h-11 rounded-md border border-border bg-surface px-3 text-sm text-text"
                onChange={(event) => setDraftFrom(event.target.value)}
                inputMode="numeric"
                placeholder={t('datePlaceholder')}
                type="text"
                value={draftFrom}
              />
              {fromError ? (
                <span
                  className="text-xs font-normal text-destructive"
                  id="period-picker-from-error"
                >
                  {fromError}
                </span>
              ) : null}
            </label>
            <label className="flex flex-1 flex-col gap-1 text-xs font-medium text-muted">
              {t('to')}
              <input
                aria-describedby={
                  toError
                    ? 'period-picker-to-error'
                    : rangeError
                      ? 'period-picker-range-error'
                      : undefined
                }
                aria-invalid={Boolean(toError || rangeError)}
                className="h-11 rounded-md border border-border bg-surface px-3 text-sm text-text"
                onChange={(event) => setDraftTo(event.target.value)}
                inputMode="numeric"
                placeholder={t('datePlaceholder')}
                type="text"
                value={draftTo}
              />
              {toError ? (
                <span className="text-xs font-normal text-destructive" id="period-picker-to-error">
                  {toError}
                </span>
              ) : null}
            </label>
          </div>
          {rangeError ? (
            <p className="mt-2 text-xs text-destructive" id="period-picker-range-error">
              {rangeError}
            </p>
          ) : null}
          <Button
            className="mt-3 w-full"
            disabled={!canApply}
            onClick={handleApplyCustom}
            size="sm"
            type="button"
          >
            {t('apply')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
