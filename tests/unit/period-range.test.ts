import { resolvePeriodRange, toDateInput } from '@/lib/periods/date-range';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('resolvePeriodRange', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-23T15:56:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('supports yesterday as a dedicated preset', () => {
    const range = resolvePeriodRange({
      allowedPresets: ['today', 'yesterday', '7j', '30j'],
      defaultPreset: '30j',
      period: 'yesterday',
    });

    expect(range.activePeriod).toBe('yesterday');
    expect(toDateInput(range.from)).toBe('2026-06-22');
    expect(toDateInput(range.to)).toBe('2026-06-22');
  });

  it('supports month (Ce mois-ci) from the first day of the current month', () => {
    const range = resolvePeriodRange({
      allowedPresets: ['today', '7j', '30j', '90j', 'month'],
      defaultPreset: '30j',
      period: 'month',
    });

    expect(range.activePeriod).toBe('month');
    expect(toDateInput(range.from)).toBe('2026-06-01');
  });

  it('returns custom when both explicit bounds are present', () => {
    const range = resolvePeriodRange({
      allowedPresets: ['today', '7j', '30j'],
      defaultPreset: '30j',
      from: '2026-06-01',
      period: '7j',
      to: '2026-06-05',
    });

    expect(range.activePeriod).toBe('custom');
    expect(toDateInput(range.from)).toBe('2026-06-01');
    expect(toDateInput(range.to)).toBe('2026-06-05');
  });
});

// Les bornes sont figées sur `Africa/Dakar` (`lib/periods/date-range.ts`). Ces cas
// pinnent donc des INSTANTS exacts, pas des jours formatés : une assertion de jour
// seule laisserait passer une borne fausse d'une heure. La zone attendue est fixée
// ici, jamais dans l'environnement — un test qui se contente de passer sous le
// fuseau du runner ne prouve rien, et c'est précisément ce que ce défaut a fait
// vivre (vert en CI sous UTC, rouge en local hors UTC).
describe('resolvePeriodRange — bornes figées sur Africa/Dakar', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function atSystemTime(iso: string) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
  }

  const allowedPresets = ['today', 'yesterday', '7j', '30j', '90j', 'month'] as const;

  describe('les quatre modes, leurs deux bornes, en été', () => {
    beforeEach(() => {
      atSystemTime('2026-06-23T15:56:00.000Z');
    });

    it('today part du minuit de Dakar et s’arrête à l’instant courant', () => {
      const range = resolvePeriodRange({ allowedPresets, defaultPreset: '30j', period: 'today' });

      expect(range.activePeriod).toBe('today');
      expect(range.from.toISOString()).toBe('2026-06-23T00:00:00.000Z');
      expect(range.to.toISOString()).toBe('2026-06-23T15:56:00.000Z');
    });

    it('yesterday couvre le jour calendaire complet de la veille', () => {
      const range = resolvePeriodRange({
        allowedPresets,
        defaultPreset: '30j',
        period: 'yesterday',
      });

      expect(range.activePeriod).toBe('yesterday');
      expect(range.from.toISOString()).toBe('2026-06-22T00:00:00.000Z');
      expect(range.to.toISOString()).toBe('2026-06-22T23:59:59.999Z');
    });

    it('month part du premier jour du mois de Dakar', () => {
      const range = resolvePeriodRange({ allowedPresets, defaultPreset: '30j', period: 'month' });

      expect(range.activePeriod).toBe('month');
      expect(range.from.toISOString()).toBe('2026-06-01T00:00:00.000Z');
      expect(range.to.toISOString()).toBe('2026-06-23T15:56:00.000Z');
    });

    it('custom borne les deux extrémités sur les jours saisis', () => {
      const range = resolvePeriodRange({
        allowedPresets,
        defaultPreset: '30j',
        from: '2026-06-01',
        period: '7j',
        to: '2026-06-05',
      });

      expect(range.activePeriod).toBe('custom');
      expect(range.from.toISOString()).toBe('2026-06-01T00:00:00.000Z');
      expect(range.to.toISOString()).toBe('2026-06-05T23:59:59.999Z');
    });

    it.each([
      ['7j', '2026-06-17T00:00:00.000Z'],
      ['30j', '2026-05-25T00:00:00.000Z'],
      ['90j', '2026-03-26T00:00:00.000Z'],
    ] as const)('le preset %s recule de N-1 jours calendaires', (period, expectedFrom) => {
      const range = resolvePeriodRange({ allowedPresets, defaultPreset: '30j', period });

      expect(range.from.toISOString()).toBe(expectedFrom);
      expect(range.to.toISOString()).toBe('2026-06-23T15:56:00.000Z');
    });
  });

  // LE cas discriminant : il sépare « décalage appliqué à `now()` » de « décalage
  // appliqué à la date analysée ». Sous `Europe/London`, `now` est ici en hiver
  // (décalage nul, donc tous les presets restent justes) tandis que les bornes
  // saisies tombent en heure d'été (BST, +1). Un correctif qui ne traiterait que les
  // presets passerait pour complet et rougirait ici : mesuré avant correctif,
  // `custom.from` rendait `2026-05-31T23:00:00.000Z`.
  it('custom en été reste juste quand now() est en hiver', () => {
    atSystemTime('2026-01-23T15:56:00.000Z');

    const range = resolvePeriodRange({
      allowedPresets,
      defaultPreset: '30j',
      from: '2026-06-01',
      period: '7j',
      to: '2026-06-05',
    });

    expect(range.activePeriod).toBe('custom');
    expect(range.from.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(range.to.toISOString()).toBe('2026-06-05T23:59:59.999Z');
  });

  // Symétrique du précédent : `now()` en été, bornes saisies en hiver. Sous un fuseau
  // à décalage négatif (`America/New_York`), c'est la borne HAUTE qui cassait.
  it('custom en hiver reste juste quand now() est en été', () => {
    atSystemTime('2026-07-14T03:12:00.000Z');

    const range = resolvePeriodRange({
      allowedPresets,
      defaultPreset: '30j',
      from: '2026-01-05',
      period: '30j',
      to: '2026-01-09',
    });

    expect(range.from.toISOString()).toBe('2026-01-05T00:00:00.000Z');
    expect(range.to.toISOString()).toBe('2026-01-09T23:59:59.999Z');
  });

  it('refuse un quantième hors bornes plutôt que de le normaliser', () => {
    atSystemTime('2026-06-23T15:56:00.000Z');

    const range = resolvePeriodRange({
      allowedPresets,
      defaultPreset: '30j',
      from: '2026-02-31',
      period: 'today',
      to: '2026-03-05',
    });

    expect(range.activePeriod).toBe('today');
  });
});
