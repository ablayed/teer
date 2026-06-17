// Helpers partagés entre les éditeurs date/heure de livraison (popup d'assignation
// + éditeur de montants). Convertissent un ISO ↔ couple <input type=date> + <input
// type=time> en heure LOCALE (le jour calendaire local pilote la vue « À livrer »).

function pad(value: number): string {
  return `${value}`.padStart(2, '0');
}

export function isoToDateTimeInputs(iso: string | null): { date: string; time: string } {
  if (!iso) {
    return { date: '', time: '' };
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return { date: '', time: '' };
  }
  return {
    date: `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`,
    time: `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`,
  };
}

export function dateTimeInputsToIso(date: string, time: string): string | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
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
