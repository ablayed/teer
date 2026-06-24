// Helpers partagés entre les éditeurs date/heure de livraison (popup d'assignation
// + éditeur de montants). Convertissent un ISO ↔ couple <input type=date> + <input
// type=time> en heure LOCALE (le jour calendaire local pilote la vue « À livrer »).

function pad(value: number): string {
  return `${value}`.padStart(2, '0');
}

function buildLocalDateTimeInputs(date: Date): { date: string; time: string } {
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:00`,
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
  const rounded = new Date(now);
  rounded.setSeconds(0, 0);
  if (rounded.getMinutes() > 0) {
    rounded.setHours(rounded.getHours() + 1, 0, 0, 0);
  } else {
    rounded.setMinutes(0, 0, 0);
  }
  return buildLocalDateTimeInputs(rounded);
}

export function isoToDateTimeInputs(iso: string | null): { date: string; time: string } {
  if (!iso) {
    return { date: '', time: '' };
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return { date: '', time: '' };
  }
  return buildLocalDateTimeInputs(parsed);
}

export function dateTimeInputsToIso(date: string, time: string): string | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const normalizedTime = normalizeHourInput(time);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(normalizedTime);
  if (!dateMatch || !timeMatch) {
    return null;
  }
  const built = new Date(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    0,
  );
  return Number.isNaN(built.getTime()) ? null : built.toISOString();
}
