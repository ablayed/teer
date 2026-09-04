'use client';

import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from '@/components/ui/drawer';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { PERIOD_PRESETS, type PeriodPreset } from '@/lib/periods/date-range';
import { cn } from '@/lib/utils';
import { format, parseISO } from 'date-fns';
import { fr } from 'date-fns/locale';
import { CalendarDays, ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { PeriodPickerBody } from './period-picker-body';
import { useMediaQuery } from './use-media-query';
import { usePeriodParams } from './use-period-params';

type PeriodPickerProps = {
  align?: 'start' | 'center' | 'end';
  presets?: readonly PeriodPreset[];
};

export function PeriodPicker({ align = 'end', presets = PERIOD_PRESETS }: PeriodPickerProps) {
  const t = useTranslations('periodPicker');
  const { active, from, isPending, selectCustom, selectPreset, to } = usePeriodParams();
  const [open, setOpen] = useState(false);
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const label =
    active === 'custom' && from && to
      ? `${format(parseISO(from), 'd MMM', { locale: fr })} ${t('rangeSeparator')} ${format(parseISO(to), 'd MMM', { locale: fr })}`
      : t(`presets.${active}`);

  const trigger = (
    <button
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={t('triggerAria', { label })}
      className={cn(
        'inline-flex min-h-12 max-w-full items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm font-medium text-text shadow-1 transition hover:bg-canvas data-[pending]:opacity-70',
      )}
      data-pending={isPending ? '' : undefined}
      onClick={() => setOpen(true)}
      type="button"
    >
      <CalendarDays aria-hidden="true" className="size-4 shrink-0 text-muted" />
      <span className="truncate">{label}</span>
      <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted" />
    </button>
  );

  // Avant montage : trigger seul, identique SSR/CSR (useMediaQuery vaut false en SSR
  // → aucune divergence d'hydratation). L'overlay n'est monté qu'ensuite, côté client.
  if (!mounted) {
    return trigger;
  }

  const body = (
    <PeriodPickerBody
      active={active}
      from={from}
      onApplied={() => setOpen(false)}
      onSelectCustom={selectCustom}
      onSelectPreset={selectPreset}
      presets={presets}
      to={to}
    />
  );

  if (isDesktop) {
    return (
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverAnchor asChild>{trigger}</PopoverAnchor>
        {/*
          Hauteur bornée par l'espace RÉELLEMENT disponible sous (ou au-dessus du)
          trigger, pas par une fraction du viewport.

          `max-h-[85vh]` était inatteignable en pratique : sur un viewport 1280x720,
          85vh = 612 px alors que le contenu ouvert sur « Personnalisé » ne fait que
          547 px. Le `max-height` ne se déclenchait donc jamais, `scrollHeight ===
          clientHeight` (545 = 545) et l'`overflow-y-auto` n'avait rien à faire
          défiler — pendant que la popover, ancrée à y=279, débordait jusqu'à y=826,
          soit 106 px SOUS le bas de la fenêtre. Le bouton « Appliquer » (top=769)
          tombait hors champ dans un wrapper `position: fixed` : ni le scroll de page
          ni `scrollIntoViewIfNeeded` ne pouvaient l'atteindre. Une plage
          personnalisée était donc invalidable sur un écran court.

          Radix calculait déjà la bonne valeur (441 px ici) et l'exposait via
          `--radix-popover-content-available-height` ; il ne l'applique jamais
          lui-même. En la consommant, le `max-height` mord réellement et
          l'`overflow-y-auto` redevient fonctionnel.
        */}
        <PopoverContent
          align={align}
          className="max-h-[var(--radix-popover-content-available-height)] w-auto min-w-[16rem] overflow-y-auto p-0"
        >
          {body}
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <>
      {trigger}
      <Drawer onOpenChange={setOpen} open={open}>
        <DrawerContent className="max-h-[90dvh] overflow-y-auto pb-6">
          <DrawerTitle className="sr-only">{t('title')}</DrawerTitle>
          <DrawerDescription className="sr-only">{t('description')}</DrawerDescription>
          {body}
        </DrawerContent>
      </Drawer>
    </>
  );
}
