import { addBusinessDays, computeEta } from '@/lib/purchases/eta';
import { describe, expect, it } from 'vitest';

// Calendrier de référence — juin 2026 :
//   Lun 1  Mar 2  Mer 3  Jeu 4  Ven 5  Sam 6  Dim 7
//   Lun 8  Mar 9  Mer 10 Jeu 11 Ven 12 Sam 13 Dim 14
//   Lun 15 ...

function d(year: number, month: number, day: number): Date {
  return new Date(year, month - 1, day); // heure locale, pas de conversion TZ
}

function isoOf(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── addBusinessDays ────────────────────────────────────────────────────────────

describe('addBusinessDays', () => {
  it('0 jour → même date', () => {
    expect(isoOf(addBusinessDays(d(2026, 6, 1), 0))).toBe('2026-06-01');
  });

  it('1 jour ouvré depuis lundi → mardi', () => {
    expect(isoOf(addBusinessDays(d(2026, 6, 1), 1))).toBe('2026-06-02'); // Lun→Mar
  });

  it('1 jour ouvré depuis vendredi → lundi (saute sam+dim)', () => {
    expect(isoOf(addBusinessDays(d(2026, 6, 5), 1))).toBe('2026-06-08'); // Ven→Lun
  });

  it('2 jours ouvrés depuis jeudi → lundi (saute ven→sam→dim)', () => {
    // Jeu 4 +1→Ven 5 (ouvré, reste=1) +1→Sam 6 (skip) +1→Dim 7 (skip) +1→Lun 8 (ouvré, reste=0)
    expect(isoOf(addBusinessDays(d(2026, 6, 4), 2))).toBe('2026-06-08');
  });

  it('5 jours ouvrés depuis lundi → lundi suivant', () => {
    // Lun 1 → Mar 2 → Mer 3 → Jeu 4 → Ven 5 → (skip Sat+Sun) → Lun 8
    expect(isoOf(addBusinessDays(d(2026, 6, 1), 5))).toBe('2026-06-08');
  });

  it('10 jours ouvrés depuis lundi → lundi deux semaines plus tard', () => {
    // 2 semaines calendaires = 10 jours ouvrés depuis un lundi
    expect(isoOf(addBusinessDays(d(2026, 6, 1), 10))).toBe('2026-06-15');
  });

  it('depuis samedi : le premier jour ouvré compté est lundi', () => {
    // Sam 6 +1→Dim 7 (skip) +1→Lun 8 (ouvré, reste=0)
    expect(isoOf(addBusinessDays(d(2026, 6, 6), 1))).toBe('2026-06-08');
  });
});

// ── computeEta ────────────────────────────────────────────────────────────────

describe('computeEta', () => {
  it("l'override gagne sur le calcul, quelle que soit la somme des jours", () => {
    const eta = computeEta({
      ordered_at: '2026-06-01',
      supplier_prep_days: 5,
      transport_days: 10,
      local_buffer_days: 2,
      eta_override: '2026-06-15',
    });
    expect(isoOf(eta)).toBe('2026-06-15');
  });

  it('sans override, 0 jours → ETA = ordered_at', () => {
    const eta = computeEta({
      ordered_at: '2026-06-05',
      supplier_prep_days: 0,
      transport_days: 0,
      local_buffer_days: 0,
      eta_override: null,
    });
    expect(isoOf(eta)).toBe('2026-06-05');
  });

  it('sans override, totalDays = prep + transport + local', () => {
    // prep=2 + transport=2 + local=1 = 5 jours ouvrés depuis lundi 1 → lundi 8
    const eta = computeEta({
      ordered_at: '2026-06-01',
      supplier_prep_days: 2,
      transport_days: 2,
      local_buffer_days: 1,
      eta_override: null,
    });
    expect(isoOf(eta)).toBe('2026-06-08');
  });

  it('sans override, commande un vendredi : ETA saute le week-end', () => {
    // Ven 5, 1 jour ouvré → Lun 8
    const eta = computeEta({
      ordered_at: '2026-06-05',
      supplier_prep_days: 0,
      transport_days: 1,
      local_buffer_days: 0,
      eta_override: null,
    });
    expect(isoOf(eta)).toBe('2026-06-08');
  });

  it('eta_override null et non fourni : calcule depuis ordered_at', () => {
    const eta = computeEta({
      ordered_at: '2026-06-01',
      supplier_prep_days: 1,
      transport_days: 0,
      local_buffer_days: 0,
      eta_override: null,
    });
    expect(isoOf(eta)).toBe('2026-06-02'); // Lun→Mar
  });
});
