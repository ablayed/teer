export type DashboardRevenuePoint = {
  date: string;
  value: number;
};

export type DashboardRevenue30d = {
  currency: string | null;
  points: DashboardRevenuePoint[];
};

export type Revenue30dOrder = {
  cash_collected_at: string | null;
  created_at: string;
  created_at_shopify: string | null;
  currency: string | null;
  total_amount: number;
};

const REVENUE_30D_MARGIN_DAYS = 60;

function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function createEmptyRevenueWindow(today = new Date()): DashboardRevenuePoint[] {
  return Array.from({ length: 30 }, (_, index) => {
    const date = new Date(today);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - (29 - index));

    return { date: dateKey(date), value: 0 };
  });
}

function dateFromOrder(value: string | null, fallback: string): Date {
  return new Date(value ?? fallback);
}

export function normalizeCurrency(value: string | null | undefined): string | null {
  const currency = value?.trim().toUpperCase();

  return currency ? currency : null;
}

// 0119 : le jour d'affichage (bucket) est cash_collected_at (date de livraison réelle,
// éditable depuis 0114) — harmonisé avec finance_kpis/P&L/Tableau. Fallback sur l'ancien
// comportement (created_at_shopify ?? created_at) UNIQUEMENT si cash_collected_at est NULL
// (commandes livrées avant l'existence du champ, avant 0096) : elles ne changent pas de jour
// affiché par ce lot.
function revenueBucketDate(order: Revenue30dOrder): Date {
  if (order.cash_collected_at) {
    return new Date(order.cash_collected_at);
  }

  return dateFromOrder(order.created_at_shopify, order.created_at);
}

export function aggregateRevenue30d(orders: Revenue30dOrder[]): DashboardRevenue30d {
  const points = createEmptyRevenueWindow();
  const pointIndex = new Map(points.map((point, index) => [point.date, index]));
  const firstPointDate = new Date(`${points[0]?.date ?? dateKey(new Date())}T00:00:00.000Z`);
  let currency: string | null = null;

  for (const order of orders) {
    const orderDate = revenueBucketDate(order);

    if (orderDate < firstPointDate) {
      continue;
    }

    const index = pointIndex.get(dateKey(orderDate));

    if (index === undefined) {
      continue;
    }

    points[index].value += Number(order.total_amount ?? 0);
    currency ??= normalizeCurrency(order.currency);
  }

  return { currency, points };
}

// PostgREST plafonne silencieusement toute requête sans .range()/.limit() à
// max_rows=1000 (supabase/config.toml:8). Sans borne, ce select all-time (`.limit(5000)`
// inopérant au-delà de max_rows) tronque aux 1000 LIVREE les plus récentes par created_at →
// graphe 30j faux dès qu'un tenant dépasse 1000 commandes livrées cumulées (Lot perf 2, H3).
//
// 0119 : cette marge ne sert plus QUE pour les commandes de repli (cash_collected_at NULL,
// livrées avant 0096) — elles restent filtrées sur created_at et bucketées sur
// created_at_shopify ?? created_at, exactement comme avant ce lot ; created_at ≥
// created_at_shopify toujours, donc cette marge continue de ne jamais les exclure.
export function revenue30dLowerBound(today = new Date()): string {
  const date = new Date(today);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - (29 + REVENUE_30D_MARGIN_DAYS));

  return date.toISOString();
}

// 0119 : borne pour le chemin cash_collected_at — champ de filtre = champ de bucket, donc
// AUCUNE marge n'est nécessaire (contrairement à revenue30dLowerBound ci-dessus, qui filtre
// sur un champ différent du champ de bucket pour les commandes de repli).
export function revenue30dCashCollectedLowerBound(today = new Date()): string {
  const date = new Date(today);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - 29);

  return date.toISOString();
}
