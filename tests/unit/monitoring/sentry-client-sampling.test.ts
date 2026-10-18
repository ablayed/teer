import {
  DEFAULT_PAGELOAD_SAMPLE_RATE,
  OTHER_TRANSACTIONS_SAMPLE_RATE,
  clientTracesSampler,
  resolvePageloadSampleRate,
} from '@/lib/monitoring/sentry-client-sampling';
import { describe, expect, it } from 'vitest';

describe('resolvePageloadSampleRate', () => {
  it('rend 0,1 quand la variable est absente ou vide', () => {
    expect(resolvePageloadSampleRate(undefined)).toBe(0.1);
    expect(resolvePageloadSampleRate('')).toBe(0.1);
    expect(resolvePageloadSampleRate('   ')).toBe(0.1);
    expect(DEFAULT_PAGELOAD_SAMPLE_RATE).toBe(0.1);
  });

  it('accepte un taux entre 0 et 1 inclus', () => {
    expect(resolvePageloadSampleRate('1')).toBe(1);
    expect(resolvePageloadSampleRate('0')).toBe(0);
    expect(resolvePageloadSampleRate('0.5')).toBe(0.5);
  });

  it('revient au défaut pour une valeur invalide, jamais à 100 % par erreur', () => {
    for (const bad of ['abc', '1.5', '-0.1', '10', 'NaN', 'Infinity', '100%']) {
      expect(resolvePageloadSampleRate(bad), bad).toBe(0.1);
    }
  });
});

describe('clientTracesSampler', () => {
  it('applique le taux configuré aux chargements de page seulement', () => {
    const sampler = clientTracesSampler(1);
    expect(sampler({ attributes: { 'sentry.op': 'pageload' } })).toBe(1);
    expect(sampler({ attributes: { 'sentry.op': 'navigation' } })).toBe(
      OTHER_TRANSACTIONS_SAMPLE_RATE,
    );
    expect(sampler({ attributes: {} })).toBe(OTHER_TRANSACTIONS_SAMPLE_RATE);
    expect(sampler({})).toBe(OTHER_TRANSACTIONS_SAMPLE_RATE);
  });

  it('ignore la décision du parent : aucune lecture de parentSampled', () => {
    const sampler = clientTracesSampler(0.1) as (c: Record<string, unknown>) => number;
    expect(sampler({ attributes: { 'sentry.op': 'pageload' }, parentSampled: false })).toBe(0.1);
  });
});
