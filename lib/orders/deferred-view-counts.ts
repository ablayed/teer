import type { OrderSavedViewId } from '@/lib/domain/order-saved-views';

// L04 — compteurs de vue reçus APRÈS la liste des commandes.
//
// La page rend la liste sans attendre ses compteurs ; ils arrivent ensuite, dans le même flux.
// Trois états, jamais confondus (règle 15) : en attente, connus, lecture échouée. Un compteur en
// attente ou en échec ne s'affiche jamais comme un nombre.
//
// Module pur : ni `env`, ni client Supabase, ni `'use server'`.

export type ViewCountsStatus = 'pending' | 'ready' | 'error';

export type DeferredViewCountsResult =
  | { ok: true; counts: Record<OrderSavedViewId, number> }
  | { ok: false };

type ViewCount = { count: number; id: OrderSavedViewId; label: string };

/**
 * Ce que l'écran a déjà posé : le résultat de quelle lecture (`token`, la promesse reçue du
 * serveur), pour quelle portée (période et boutique), et s'il a abouti.
 */
export type AppliedViewCounts = { ok: boolean; scope: string; token: unknown } | null;

/**
 * Valeur d'une promesse si elle est DÉJÀ réglée, `null` sinon — sans jamais l'attendre.
 * La page s'en sert une fois la liste prête : des compteurs déjà arrivés sont rendus avec elle ;
 * seuls des compteurs réellement plus lents que la liste arrivent ensuite, dans le flux.
 */
export function settledValueOrNull<T>(promise: Promise<T>): Promise<T | null> {
  return Promise.race([promise, Promise.resolve(null)]);
}

/** Portée des compteurs : ils ne dépendent ni de la vue active, ni de la recherche. */
export function viewCountsScope(dateFrom: string, dateTo: string, shopId: string | null): string {
  return `${dateFrom}|${dateTo}|${shopId ?? ''}`;
}

/**
 * État des compteurs TANT QUE la lecture attendue n'est pas arrivée.
 * Les derniers compteurs connus restent affichés s'ils valent pour la même portée — un
 * changement de vue ou un rafraîchissement ne les fait pas clignoter. Sinon, on attend : les
 * compteurs d'une autre période ne sont jamais montrés comme ceux de la période demandée.
 */
export function statusWhileWaiting(applied: AppliedViewCounts, scope: string): ViewCountsStatus {
  return applied?.ok && applied.scope === scope ? 'ready' : 'pending';
}

/**
 * Ce qu'il faut afficher une fois la lecture arrivée.
 * Avant que l'écran l'ait posée dans son état (premier rendu, HTML du serveur), on affiche le
 * résultat reçu. Après, c'est l'état de l'écran qui fait foi : il porte en plus les gestes de
 * l'utilisateur.
 */
export function resolveArrivedViewCounts<T extends ViewCount>({
  applied,
  displayedViews,
  result,
  token,
}: {
  applied: AppliedViewCounts;
  displayedViews: T[];
  result: DeferredViewCountsResult;
  token: unknown;
}): { status: ViewCountsStatus; views: T[] } {
  if (applied && applied.token === token) {
    return { status: applied.ok ? 'ready' : 'error', views: displayedViews };
  }
  if (!result.ok) {
    return { status: 'error', views: displayedViews };
  }
  return { status: 'ready', views: withViewCounts(displayedViews, result.counts) };
}

export function withViewCounts<T extends ViewCount>(
  views: T[],
  counts: Record<OrderSavedViewId, number>,
): T[] {
  return views.map((view) => ({ ...view, count: counts[view.id] }));
}

/**
 * Libellé d'une vue selon l'état de son compteur. En attente : le libellé seul. En échec : un
 * tiret, jamais un zéro.
 */
export function formatViewChipLabel(label: string, count: number, status: ViewCountsStatus) {
  if (status === 'ready') {
    return `${label} (${count})`;
  }
  return status === 'error' ? `${label} (—)` : label;
}
