// Helpers partagés entre les éditeurs date/heure de livraison (popup d'assignation,
// dialogue de transition, éditeur de montants). Convertissent un ISO ↔ couple
// <input type=date> + <input type=time>.
//
// FUSEAU FIGÉ SUR `Africa/Dakar` — jamais celui du navigateur.
//
// Pourquoi : ces trois consommateurs sont tous `'use client'`, et la valeur qu'ils
// produisent part en base dans `orders.scheduled_for`. Or
// `cash_collected_at = coalesce(p_delivered_at, scheduled_for, now())`
// (`0148`:299-306) : une valeur construite dans le fuseau du poste inscrit
// durablement une mauvaise date de CA. Mesuré : un utilisateur en `Europe/London`
// en été qui programme une livraison pour le 18 septembre à 00:00 écrivait
// `2026-09-17T23:00:00Z`, donc un CA au 17.
//
// C'est l'extension d'une règle qui existait déjà, pas une règle nouvelle :
// `lib/format/date.ts` fige l'AFFICHAGE sur `Africa/Dakar` depuis sa ligne 1. Ce
// module fige la SAISIE sur le même fuseau, pour que le jour calendaire saisi soit
// celui que le marchand relira.
//
// Ce module ne corrige PAS les bornes de période (`resolvePeriodRange`), qui
// dépendent du `TZ` du process serveur : deux causes distinctes, deux correctifs.
// Poser `TZ=Africa/Dakar` sur le runtime ne changerait rien ici, aucune variable
// serveur n'atteignant le navigateur.

const DATE_TIME_ZONE = 'Africa/Dakar';

// `Africa/Dakar` est à UTC+00:00 toute l'année, sans heure d'été. On ne le PRÉSUME
// pourtant pas : le décalage est mesuré à l'instant considéré, pour que ce module
// reste juste si la base de données de fuseaux changeait.
const zoneFieldsFormatter = new Intl.DateTimeFormat('en-US', {
  day: '2-digit',
  hour: '2-digit',
  hour12: false,
  minute: '2-digit',
  month: '2-digit',
  second: '2-digit',
  timeZone: DATE_TIME_ZONE,
  year: 'numeric',
});

type ZoneFields = {
  day: number;
  hour: number;
  minute: number;
  month: number;
  second: number;
  year: number;
};

function pad(value: number): string {
  return `${value}`.padStart(2, '0');
}

// Décompose un instant en champs d'horloge murale de `Africa/Dakar`.
function zoneFields(date: Date): ZoneFields {
  const parts = zoneFieldsFormatter.formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const hour = read('hour');
  return {
    day: read('day'),
    // `hour12: false` rend minuit « 24 » sur certains moteurs (ICU) : à normaliser.
    hour: hour === 24 ? 0 : hour,
    minute: read('minute'),
    month: read('month'),
    second: read('second'),
    year: read('year'),
  };
}

// Décalage du fuseau à cet instant, en millisecondes.
function zoneOffsetMs(date: Date): number {
  const fields = zoneFields(date);
  const wallAsUtc = Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second,
  );
  // On compare des secondes pleines des deux côtés : `formatToParts` ne rend pas les
  // millisecondes, donc les inclure ferait dériver l'offset de l'ordre de la seconde.
  return wallAsUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// Inverse de `zoneFields` : l'instant dont l'horloge murale de `Africa/Dakar` est
// celle demandée. `Date.UTC` normalise un dépassement (heure 24 → jour suivant).
function zonedWallTimeToDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstOffset = zoneOffsetMs(new Date(guess));
  const candidate = new Date(guess - firstOffset);
  // Second passage : seul utile si l'instant candidat tombe de l'autre côté d'une
  // bascule d'offset. `Africa/Dakar` n'en a aucune — on ne s'y fie pas pour autant.
  const secondOffset = zoneOffsetMs(candidate);
  return firstOffset === secondOffset ? candidate : new Date(guess - secondOffset);
}

function buildZonedDateTimeInputs(date: Date): { date: string; time: string } {
  const fields = zoneFields(date);
  return {
    date: `${fields.year}-${pad(fields.month)}-${pad(fields.day)}`,
    time: `${pad(fields.hour)}:00`,
  };
}

export function normalizeHourInput(time: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) {
    return '';
  }
  const hour = Number(match[1]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return '';
  }
  return `${pad(hour)}:00`;
}

export function nextWholeHourInputs(now = new Date()): { date: string; time: string } {
  const fields = zoneFields(now);
  const hour = fields.minute > 0 || fields.second > 0 ? fields.hour + 1 : fields.hour;
  // Recomposition plutôt qu'un `setHours` : elle normalise le passage au jour suivant
  // quand l'heure arrondie dépasse 23, en heure de Dakar et non en heure du poste.
  return buildZonedDateTimeInputs(
    zonedWallTimeToDate(fields.year, fields.month, fields.day, hour, 0),
  );
}

export function isoToDateTimeInputs(iso: string | null): { date: string; time: string } {
  if (!iso) {
    return { date: '', time: '' };
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return { date: '', time: '' };
  }
  return buildZonedDateTimeInputs(parsed);
}

export function dateTimeInputsToIso(date: string, time: string): string | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const normalizedTime = normalizeHourInput(time);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(normalizedTime);
  if (!dateMatch || !timeMatch) {
    return null;
  }
  const built = zonedWallTimeToDate(
    Number(dateMatch[1]),
    Number(dateMatch[2]),
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
  );
  return Number.isNaN(built.getTime()) ? null : built.toISOString();
}
