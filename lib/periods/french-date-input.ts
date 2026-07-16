const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FRENCH_DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

function hasValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }

  const daysInMonth = new Date(year, month, 0).getDate();
  return day <= daysInMonth;
}

export function frenchDateInputToIso(value: string): string | null {
  const match = FRENCH_DATE_RE.exec(value);

  if (!match) {
    return null;
  }

  const [, dayValue, monthValue, yearValue] = match;
  const day = Number(dayValue);
  const month = Number(monthValue);
  const year = Number(yearValue);

  if (!hasValidCalendarDate(year, month, day)) {
    return null;
  }

  return `${yearValue}-${monthValue}-${dayValue}`;
}

export function isoDateToFrenchDateInput(value: string | null): string {
  if (!value) {
    return '';
  }

  const match = ISO_DATE_RE.exec(value);

  if (!match) {
    return '';
  }

  const [, yearValue, monthValue, dayValue] = match;
  const iso = `${yearValue}-${monthValue}-${dayValue}`;
  const french = `${dayValue}/${monthValue}/${yearValue}`;

  return frenchDateInputToIso(french) === iso ? french : '';
}
