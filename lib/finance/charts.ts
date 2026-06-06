// Pure aggregation helpers for the period-aware finance charts (Phase 6c).
// No DB access. Senegal is GMT (Africa/Dakar, no DST) → UTC date slice == local date.

export type ChartOrder = {
  totalAmount: number;
  cashCollectedAt: string | null; // ISO timestamptz, null if not collected
  shopId: string | null;
};

export type RevenuePoint = { date: string; value: number };
export type ShopRevenuePoint = { name: string; revenue: number };
export type FunnelPoint = { status: string; count: number };

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

// Génère les clés de jour (UTC, AAAA-MM-JJ) de `fromISO` à `toISO` inclus.
// Cap de sécurité à 366 jours pour éviter une fenêtre démesurée sur une période custom.
function dayWindow(fromISO: string, toISO: string): string[] {
  const start = new Date(`${dayKey(fromISO)}T00:00:00.000Z`);
  const end = new Date(`${dayKey(toISO)}T00:00:00.000Z`);
  const keys: string[] = [];
  const cursor = new Date(start);
  let guard = 0;
  while (cursor.getTime() <= end.getTime() && guard < 366) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    guard += 1;
  }
  return keys;
}

// CA encaissé par jour sur la période : somme des total_amount des commandes dont
// cash_collected_at tombe ce jour-là. Renvoie un point par jour de la fenêtre (0 si rien).
export function bucketRevenueByDay(
  orders: ChartOrder[],
  fromISO: string,
  toISO: string,
): RevenuePoint[] {
  const points = dayWindow(fromISO, toISO).map((date) => ({ date, value: 0 }));
  const index = new Map(points.map((p, i) => [p.date, i]));
  for (const o of orders) {
    if (!o.cashCollectedAt) continue;
    const i = index.get(dayKey(o.cashCollectedAt));
    if (i === undefined) continue;
    points[i].value += o.totalAmount;
  }
  return points;
}

// CA encaissé par boutique sur la période. Les commandes sans boutique sont ignorées.
// shopNameById : id boutique → libellé affiché. Trié par CA décroissant.
export function aggregateShopRevenue(
  orders: ChartOrder[],
  shopNameById: Map<string, string>,
): ShopRevenuePoint[] {
  const byShop = new Map<string, number>();
  for (const o of orders) {
    if (!o.cashCollectedAt || !o.shopId) continue;
    byShop.set(o.shopId, (byShop.get(o.shopId) ?? 0) + o.totalAmount);
  }
  return [...byShop.entries()]
    .map(([shopId, revenue]) => ({ name: shopNameById.get(shopId) ?? shopId, revenue }))
    .sort((a, b) => b.revenue - a.revenue);
}

// Entonnoir COD sur la période : compte les commandes (par cod_status) créées dans la période.
// `statuses` fixe l'ordre d'affichage ; les statuts absents ressortent à 0.
export function aggregateFunnel(codStatuses: string[], statuses: readonly string[]): FunnelPoint[] {
  const counts = new Map<string, number>(statuses.map((s) => [s, 0]));
  for (const s of codStatuses) {
    if (counts.has(s)) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return statuses.map((status) => ({ status, count: counts.get(status) ?? 0 }));
}
