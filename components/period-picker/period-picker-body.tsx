'use client';

import { Button } from '@/components/ui/button';
import type { ActivePeriod, PeriodPreset } from '@/lib/periods/date-range';
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
  const [draftFrom, setDraftFrom] = useState(from ?? '');
  const [draftTo, setDraftTo] = useState(to ?? '');

  const canApply = Boolean(draftFrom && draftTo && draftFrom <= draftTo);

  const handleApplyCustom = () => {
    if (!canApply) {
      return;
    }
    onSelectCustom(draftFrom, draftTo);
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
                className="h-11 rounded-md border border-border bg-surface px-3 text-sm text-text"
                max={draftTo || undefined}
                onChange={(event) => setDraftFrom(event.target.value)}
                type="date"
                value={draftFrom}
              />
            </label>
            <label className="flex flex-1 flex-col gap-1 text-xs font-medium text-muted">
              {t('to')}
              <input
                className="h-11 rounded-md border border-border bg-surface px-3 text-sm text-text"
                min={draftFrom || undefined}
                onChange={(event) => setDraftTo(event.target.value)}
                type="date"
                value={draftTo}
              />
            </label>
          </div>
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
