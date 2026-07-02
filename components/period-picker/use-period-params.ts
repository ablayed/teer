'use client';

import { type ActivePeriod, PERIOD_PRESETS, type PeriodPreset } from '@/lib/periods/date-range';
import { parseAsString, parseAsStringLiteral, useQueryStates } from 'nuqs';
import { useTransition } from 'react';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Source unique de l'état de période. nuqs fusionne les params EN PLACE : écrire
// `period`/`from`/`to` ne touche jamais `q`, `shop`, `vue`, `tab`, etc. — ce qui
// corrige structurellement l'ancien bug « perte de from/to en cliquant un preset ».
// Contrat d'URL conservé (lecture serveur inchangée) : un preset ne porte QUE
// `period` (from/to effacés) ; « Personnalisé » ne porte QUE `from`+`to`.
export function usePeriodParams() {
  const [isPending, startTransition] = useTransition();
  const [{ period, from, to }, setParams] = useQueryStates(
    {
      period: parseAsStringLiteral(PERIOD_PRESETS).withDefault('30j'),
      from: parseAsString,
      to: parseAsString,
    },
    { history: 'push', shallow: false, scroll: false, startTransition },
  );

  const validFrom = from && DATE_RE.test(from) ? from : null;
  const validTo = to && DATE_RE.test(to) ? to : null;
  const isCustom = Boolean(validFrom && validTo);
  const active: ActivePeriod = isCustom ? 'custom' : period;

  const selectPreset = (preset: PeriodPreset) => {
    // Efface les bornes : sinon `resolvePeriodRange` privilégie from/to et le clic
    // du preset est ignoré. nuqs retire `period` de l'URL quand il vaut le défaut.
    void setParams({ period: preset, from: null, to: null });
  };

  const selectCustom = (nextFrom: string, nextTo: string) => {
    void setParams({ period: null, from: nextFrom, to: nextTo });
  };

  return {
    active,
    from: isCustom ? validFrom : null,
    to: isCustom ? validTo : null,
    isPending,
    selectPreset,
    selectCustom,
  };
}
