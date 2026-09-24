// Bornes de période (PeriodPicker et toutes les lectures qui en dépendent).
//
// FUSEAU FIGÉ SUR `Africa/Dakar` — jamais celui du processus ni du navigateur.
//
// Pourquoi : avant ce lot, les six primitives ci-dessous mélangeaient deux régimes.
// L'arithmétique de calendrier (`setHours`, `setDate`, `new Date('…T00:00:00')`)
// s'évaluait dans le fuseau du PROCESSUS, tandis que `toDateInput` formatait en UTC.
// Ni l'un ni l'autre seul ne produisait de décalage : c'est leur superposition.
// Mesuré (DIAG-TZ-01) : sous `Europe/London`, `custom.from = '2026-06-01'` rendait
// `2026-05-31`, et cela même avec un `now()` d'hiver — le décalage appliqué est celui
// de la date ANALYSÉE, pas celui de `now()`.
//
// Ce module ne normalise PAS le processus : poser `TZ=UTC` donnerait le bon résultat
// par coïncidence de décalage (Dakar est à UTC+00:00) sans supprimer la dépendance
// implicite, et reviendrait au premier environnement à décalage non nul.
//
// Le calcul de décalage n'est pas réimplémenté ici : il est emprunté à
// `lib/format/datetime-input.ts`, qui MESURE le décalage de `Africa/Dakar` à
// l'instant considéré au lieu de le présumer nul. C'est la propagation aux bornes de
// lecture de la décision déjà portée par `lib/format/date.ts:1` (affichage) et par
// ce module-là (saisie).
import { dateTimeInputsToIso, isoToDateTimeInputs } from '@/lib/format/datetime-input';

export type PeriodPreset = 'today' | 'yesterday' | '7j' | '30j' | '90j' | 'month';
export type ActivePeriod = PeriodPreset | 'custom';

// Ordre d'affichage canonique du PeriodPicker (tokens URL inchangés — cf. décision
// ticket : zéro rupture de compat, on garde 7j/30j/90j et on AJOUTE month/custom).
export const PERIOD_PRESETS: readonly PeriodPreset[] = [
  'today',
  'yesterday',
  '7j',
  '30j',
  '90j',
  'month',
];

// Instant du minuit `Africa/Dakar` du jour calendaire donné. `dateTimeInputsToIso`
// ne rend `null` que sur une chaîne mal formée ; les appels internes lui passent
// toujours une sortie de `toDateInput`/`shiftDayInput`.
function zonedDayStart(dayInput: string): Date {
  const iso = dateTimeInputsToIso(dayInput, '00:00');
  return new Date(iso ?? Number.NaN);
}

function pad(value: number): string {
  return `${value}`.padStart(2, '0');
}

// Décale un jour calendaire d'un nombre entier de jours. Arithmétique de calendrier
// PURE : `Date.UTC` sert ici d'entier normalisateur (fin de mois, année bissextile)
// et les champs sont relus par les accesseurs UTC, donc exactement ceux qui ont été
// écrits. Aucun fuseau n'intervient — ce n'est pas une conversion de zone.
function shiftDayInput(dayInput: string, days: number): string {
  const [year, month, day] = dayInput.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

export function startOfDay(date: Date): Date {
  return zonedDayStart(toDateInput(date));
}

export function startOfMonth(date: Date): Date {
  return zonedDayStart(`${toDateInput(date).slice(0, 8)}01`);
}

// Dernier instant représentable du jour, soit le minuit du lendemain moins 1 ms.
// Passer par le lendemain plutôt que par « 23:59:59.999 » évite de présumer qu'un
// jour dure 24 h : un jour à bascule d'heure d'été n'a pas la même longueur.
export function endOfDay(date: Date): Date {
  const nextDayStart = zonedDayStart(shiftDayInput(toDateInput(date), 1));
  return new Date(nextDayStart.getTime() - 1);
}

export function parseDateInput(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }

  const iso = dateTimeInputsToIso(value, '00:00');
  if (!iso) {
    return null;
  }

  // Un quantième hors bornes est normalisé silencieusement des deux côtés : mesuré,
  // `new Date('2026-02-31T00:00:00')` rendait déjà `2026-03-03` (analyseur permissif
  // de V8), et `Date.UTC` fait de même. L'aller-retour ci-dessous le REFUSE — c'est
  // un durcissement incident de ce lot, pas la préservation d'un comportement, et il
  // est verrouillé par un test. Jamais une seconde validation de calendrier.
  const date = new Date(iso);
  return toDateInput(date) === value ? date : null;
}

// Jour calendaire `Africa/Dakar` de l'instant donné. N'est PAS un sérialiseur UTC :
// ses deux consommateurs de production (`app/(app)/finances/page.tsx`) en font des
// paramètres d'URL relus par `parseDateInput` et un filtre sur `expense.spent_at`,
// colonne `date` (`0035`:386) — deux usages de jour calendaire, jamais d'instant.
export function toDateInput(value: Date): string {
  return isoToDateTimeInputs(value.toISOString()).date;
}

export function resolvePeriodRange({
  allowedPresets,
  defaultPreset,
  from,
  period,
  to,
}: {
  allowedPresets: readonly PeriodPreset[];
  defaultPreset: PeriodPreset;
  from?: string;
  period?: string;
  to?: string;
}): { activePeriod: ActivePeriod; from: Date; to: Date } {
  const now = new Date();
  const customFrom = parseDateInput(from);
  const customTo = parseDateInput(to);

  if (customFrom && customTo) {
    return { activePeriod: 'custom', from: customFrom, to: endOfDay(customTo) };
  }

  const preset = allowedPresets.includes(period as PeriodPreset)
    ? (period as PeriodPreset)
    : defaultPreset;

  if (preset === 'today') {
    return { activePeriod: 'today', from: startOfDay(now), to: now };
  }

  if (preset === 'yesterday') {
    const yesterday = zonedDayStart(shiftDayInput(toDateInput(now), -1));
    return { activePeriod: 'yesterday', from: yesterday, to: endOfDay(yesterday) };
  }

  if (preset === 'month') {
    return { activePeriod: 'month', from: startOfMonth(now), to: now };
  }

  const days = preset === '7j' ? 7 : preset === '90j' ? 90 : 30;
  const start = zonedDayStart(shiftDayInput(toDateInput(now), -(days - 1)));

  return { activePeriod: preset, from: start, to: now };
}
