import { orderSavedViewIds } from '@/lib/domain/order-saved-views';
import type { OrderSavedViewId } from '@/lib/domain/order-saved-views';
import {
  formatViewChipLabel,
  resolveArrivedViewCounts,
  settledValueOrNull,
  statusWhileWaiting,
  viewCountsScope,
  withViewCounts,
} from '@/lib/orders/deferred-view-counts';
import { describe, expect, it } from 'vitest';

// L04 — les compteurs de vue arrivent après la liste. Ce fichier verrouille la règle 15 sur ce
// chemin : « en attente » et « lecture échouée » ne s'affichent jamais comme un nombre, et les
// compteurs d'une autre période ne sont jamais montrés comme ceux de la période demandée.

const counts = (value: number) =>
  Object.fromEntries(orderSavedViewIds.map((id, index) => [id, value + index])) as Record<
    OrderSavedViewId,
    number
  >;
const views = (value: number) =>
  orderSavedViewIds.map((id, index) => ({ count: value + index, id, label: `Vue ${id}` }));

const MARS = viewCountsScope('2026-03-01', '2026-03-31', 'shop-a');
const AVRIL = viewCountsScope('2026-04-01', '2026-04-30', 'shop-a');
const tokenA = { lecture: 'A' };
const tokenB = { lecture: 'B' };

describe('L04 — état des compteurs tant que la lecture n est pas arrivée', () => {
  it('aucun compteur connu : en attente', () => {
    expect(statusWhileWaiting(null, MARS)).toBe('pending');
  });

  it('compteurs connus pour la même portée : ils restent affichés', () => {
    expect(statusWhileWaiting({ ok: true, scope: MARS, token: tokenA }, MARS)).toBe('ready');
  });

  it('compteurs connus pour une AUTRE période : en attente, jamais ceux de l autre période', () => {
    expect(statusWhileWaiting({ ok: true, scope: MARS, token: tokenA }, AVRIL)).toBe('pending');
  });

  it('une autre boutique est une autre portée', () => {
    expect(viewCountsScope('a', 'b', 'shop-a')).not.toBe(viewCountsScope('a', 'b', 'shop-b'));
    expect(viewCountsScope('a', 'b', null)).not.toBe(viewCountsScope('a', 'b', 'shop-a'));
  });

  it('une lecture précédente en échec ne vaut pas compteurs connus', () => {
    expect(statusWhileWaiting({ ok: false, scope: MARS, token: tokenA }, MARS)).toBe('pending');
  });
});

describe('L04 — ce qui s affiche une fois la lecture arrivée', () => {
  it('avant que l écran l ait posée : les compteurs reçus', () => {
    const arrived = resolveArrivedViewCounts({
      applied: null,
      displayedViews: views(0),
      result: { counts: counts(40), ok: true },
      token: tokenA,
    });
    expect(arrived.status).toBe('ready');
    expect(arrived.views.map((view) => view.count)).toEqual(Object.values(counts(40)));
    expect(arrived.views.map((view) => view.label)).toEqual(views(0).map((view) => view.label));
  });

  it('une fois posée : l état de l écran fait foi, gestes de l utilisateur compris', () => {
    const displayed = views(41);
    const arrived = resolveArrivedViewCounts({
      applied: { ok: true, scope: MARS, token: tokenA },
      displayedViews: displayed,
      result: { counts: counts(40), ok: true },
      token: tokenA,
    });
    expect(arrived).toEqual({ status: 'ready', views: displayed });
  });

  it('une lecture plus récente remplace les compteurs posés par la précédente', () => {
    const arrived = resolveArrivedViewCounts({
      applied: { ok: true, scope: MARS, token: tokenA },
      displayedViews: views(41),
      result: { counts: counts(50), ok: true },
      token: tokenB,
    });
    expect(arrived.views.map((view) => view.count)).toEqual(Object.values(counts(50)));
  });

  it('lecture échouée : état d erreur, avant comme après la pose', () => {
    const failed = { ok: false } as const;
    expect(
      resolveArrivedViewCounts({
        applied: null,
        displayedViews: views(0),
        result: failed,
        token: tokenA,
      }).status,
    ).toBe('error');
    expect(
      resolveArrivedViewCounts({
        applied: { ok: false, scope: MARS, token: tokenA },
        displayedViews: views(0),
        result: failed,
        token: tokenA,
      }).status,
    ).toBe('error');
  });
});

describe('L04 — compteurs déjà arrivés quand la liste est prête', () => {
  it('promesse déjà réglée : sa valeur, sans attente', async () => {
    const value = { counts: counts(3), ok: true } as const;
    expect(await settledValueOrNull(Promise.resolve(value))).toBe(value);
  });

  it('promesse d une fonction async déjà terminée : sa valeur', async () => {
    const done = (async () => 'compteurs')();
    await done;
    expect(await settledValueOrNull(done)).toBe('compteurs');
  });

  it('promesse encore en attente : null, et elle n est pas attendue', async () => {
    let release: (value: string) => void = () => undefined;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    expect(await settledValueOrNull(pending)).toBeNull();
    release('plus tard');
    expect(await pending).toBe('plus tard');
    expect(await settledValueOrNull(pending)).toBe('plus tard');
  });

  it('un échec de lecture déjà arrivé est rendu tel quel, jamais transformé en attente', async () => {
    expect(await settledValueOrNull(Promise.resolve({ ok: false }))).toEqual({ ok: false });
  });
});

describe('L04 — libellé d une pastille', () => {
  it('connu : le nombre, zéro compris', () => {
    expect(formatViewChipLabel('À appeler', 30, 'ready')).toBe('À appeler (30)');
    expect(formatViewChipLabel('À appeler', 0, 'ready')).toBe('À appeler (0)');
  });

  it('en attente : aucun nombre, quel que soit le compteur porté', () => {
    expect(formatViewChipLabel('À appeler', 0, 'pending')).toBe('À appeler');
    expect(formatViewChipLabel('À appeler', 30, 'pending')).toBe('À appeler');
  });

  it('en échec : un tiret, jamais un zéro', () => {
    expect(formatViewChipLabel('À appeler', 0, 'error')).toBe('À appeler (—)');
    expect(formatViewChipLabel('À appeler', 0, 'error')).not.toMatch(/\d/);
  });

  it('withViewCounts garde l identité et le libellé des vues', () => {
    const result = withViewCounts(views(0), counts(7));
    expect(result.map((view) => view.id)).toEqual([...orderSavedViewIds]);
    expect(result[0]).toEqual({ count: 7, id: orderSavedViewIds[0], label: views(0)[0].label });
  });
});
