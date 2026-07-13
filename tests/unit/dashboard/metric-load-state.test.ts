import { toMetricLoadState } from '@/lib/dashboard/metric-load-state';
import { describe, expect, it } from 'vitest';

describe('toMetricLoadState', () => {
  it('distingue le chargement avant résultat', () => {
    expect(toMetricLoadState(undefined, () => false)).toEqual({ status: 'loading' });
  });

  it('distingue une erreur technique d’un état vide métier', () => {
    expect(toMetricLoadState({ ok: false, errorCode: 'query_error' }, () => false)).toEqual({
      errorCode: 'query_error',
      status: 'error',
    });
  });

  it('distingue le vrai vide pour CA encaissé', () => {
    expect(
      toMetricLoadState({ ok: true, data: { caMinor: 0 } }, (data) => data.caMinor <= 0),
    ).toEqual({
      data: { caMinor: 0 },
      status: 'empty',
    });
  });

  it('distingue le vrai vide pour Livraisons', () => {
    expect(
      toMetricLoadState(
        { ok: true, data: { products: [], totalDeliveries: 0 } },
        (data) => data.totalDeliveries <= 0,
      ),
    ).toEqual({
      data: { products: [], totalDeliveries: 0 },
      status: 'empty',
    });
  });

  it('distingue le vrai vide du graphe de taux de livraison', () => {
    expect(
      toMetricLoadState({ ok: true, data: { trends: [{ totalOrders: 0 }] } }, (data) =>
        data.trends.every((point) => point.totalOrders === 0),
      ),
    ).toEqual({
      data: { trends: [{ totalOrders: 0 }] },
      status: 'empty',
    });
  });

  it('distingue le vrai vide pour CA par produit', () => {
    expect(
      toMetricLoadState(
        { ok: true, data: { items: [], totalMinor: 0 } },
        (data) => data.totalMinor <= 0 || data.items.length === 0,
      ),
    ).toEqual({
      data: { items: [], totalMinor: 0 },
      status: 'empty',
    });
  });

  it('renvoie ready quand la donnée métier existe', () => {
    expect(
      toMetricLoadState({ ok: true, data: { caMinor: 12_000 } }, (data) => data.caMinor <= 0),
    ).toEqual({
      data: { caMinor: 12_000 },
      status: 'ready',
    });
  });
});
