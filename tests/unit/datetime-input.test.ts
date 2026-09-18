// COHERENCE-01 — la conversion ISO ↔ champs date/heure est figée sur `Africa/Dakar`
// (voir l'en-tête de lib/format/datetime-input.ts). Ce fichier doit donc être VERT
// SOUS N'IMPORTE QUEL `TZ` de process, et pas seulement sous UTC comme avant ce lot.
//
// Conséquence sur la façon d'écrire les fixtures : plus aucun `new Date(y, m, d, h, mi)`
// (constructeur LOCAL au process, qui rendait ces tests dépendants du fuseau). Tout
// instant d'entrée est un ISO explicite, toute sortie attendue est une constante.
// Mesuré vert sous `TZ=Europe/London` ET `TZ=Africa/Dakar`.

import {
  dateTimeInputsToIso,
  isoToDateTimeInputs,
  nextWholeHourInputs,
  normalizeHourInput,
} from '@/lib/format/datetime-input';
import { describe, expect, it } from 'vitest';

describe('datetime input helpers', () => {
  it('normalizes any valid time input to the hour only', () => {
    expect(normalizeHourInput('15:56')).toBe('15:00');
    expect(normalizeHourInput('09:00')).toBe('09:00');
    expect(normalizeHourInput('24:00')).toBe('');
  });

  it('prefills the next whole hour when the current time has minutes', () => {
    expect(nextWholeHourInputs(new Date('2026-06-23T15:56:00.000Z'))).toEqual({
      date: '2026-06-23',
      time: '16:00',
    });
    expect(nextWholeHourInputs(new Date('2026-06-23T12:45:00.000Z'))).toEqual({
      date: '2026-06-23',
      time: '13:00',
    });
  });

  it('keeps the current hour when already on the hour', () => {
    expect(nextWholeHourInputs(new Date('2026-06-23T08:00:00.000Z'))).toEqual({
      date: '2026-06-23',
      time: '08:00',
    });
  });

  it('rolls over to the next Dakar day when the rounded hour passes midnight', () => {
    expect(nextWholeHourInputs(new Date('2026-06-23T23:10:00.000Z'))).toEqual({
      date: '2026-06-24',
      time: '00:00',
    });
  });

  it('drops minutes when converting iso values for hour-only inputs', () => {
    expect(isoToDateTimeInputs('2026-06-23T15:56:00.000Z').time).toBe('15:00');
  });

  it('stores hour-only inputs with zeroed minutes', () => {
    expect(dateTimeInputsToIso('2026-06-23', '15:56')).toBe('2026-06-23T15:00:00.000Z');
  });

  it('returns null on malformed inputs, never a silently wrong instant', () => {
    expect(dateTimeInputsToIso('23/06/2026', '15:00')).toBeNull();
    expect(dateTimeInputsToIso('2026-06-23', '25:00')).toBeNull();
    expect(dateTimeInputsToIso('', '')).toBeNull();
    expect(isoToDateTimeInputs('pas une date')).toEqual({ date: '', time: '' });
    expect(isoToDateTimeInputs(null)).toEqual({ date: '', time: '' });
  });

  // ── Le défaut que ce lot ferme ──────────────────────────────────────────────
  // Avant COHERENCE-01, `dateTimeInputsToIso` construisait sa date avec
  // `new Date(y, m - 1, d, h, 0, 0)`, donc dans le fuseau du POSTE. Une saisie
  // « 18 septembre, 00:00 » depuis un poste en UTC+1 écrivait
  // `2026-09-17T23:00:00Z` en base, et comme
  // `cash_collected_at = coalesce(p_delivered_at, scheduled_for, now())`, le CA de
  // cette commande tombait le 17. Le fuseau du poste n'étant enregistré nulle part,
  // la valeur était irrécupérable — d'où l'absence de backfill.
  it('minuit saisi désigne minuit à Dakar, quel que soit le fuseau du poste', () => {
    // La valeur exacte, pas « une valeur cohérente » : c'est le chiffre qui a été
    // mesuré faux (2026-09-17T23:00:00.000Z sous Europe/London en été).
    expect(dateTimeInputsToIso('2026-09-18', '00:00')).toBe('2026-09-18T00:00:00.000Z');
  });

  it('aller-retour ISO → champs → ISO : la même valeur, sans dérive de jour', () => {
    const cases = [
      '2026-09-18T00:00:00.000Z',
      '2026-09-17T23:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      '2026-12-31T23:00:00.000Z',
      // Un instant en pleine heure d'été européenne : c'est la période où un poste
      // en Europe/London est décalé de Dakar, donc celle qui révélait le défaut.
      '2026-07-15T12:00:00.000Z',
    ];

    for (const iso of cases) {
      const fields = isoToDateTimeInputs(iso);
      expect(dateTimeInputsToIso(fields.date, fields.time)).toBe(iso);
    }
  });

  it('les 24 heures d’une journée font un aller-retour stable', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const iso = `2026-09-18T${`${hour}`.padStart(2, '0')}:00:00.000Z`;
      const fields = isoToDateTimeInputs(iso);
      expect(fields.date).toBe('2026-09-18');
      expect(dateTimeInputsToIso(fields.date, fields.time)).toBe(iso);
    }
  });
});
