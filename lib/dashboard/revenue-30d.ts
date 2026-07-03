export type DashboardRevenuePoint = {
  date: string;
  value: number;
};

export type DashboardRevenue30d = {
  currency: string | null;
  points: DashboardRevenuePoint[];
};

export type Revenue30dOrder = {
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

export function aggregateRevenue30d(orders: Revenue30dOrder[]): DashboardRevenue30d {
  const points = createEmptyRevenueWindow();
  const pointIndex = new Map(points.map((point, index) => [point.date, index]));
  const firstPointDate = new Date(`${points[0]?.date ?? dateKey(new Date())}T00:00:00.000Z`);
  let currency: string | null = null;

  for (const order of orders) {
    const orderDate = dateFromOrder(order.created_at_shopify, order.created_at);

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
// Fenêtrage sûr : created_at ≥ created_at_shopify toujours (l'import suit la commande), donc
// borner sur created_at ne peut pas exclure une commande dont la date d'affichage
// (created_at_shopify ?? created_at) tombe dans la fenêtre 30j. Marge 60j en plus par
// prudence.
export function revenue30dLowerBound(today = new Date()): string {
  const date = new Date(today);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - (29 + REVENUE_30D_MARGIN_DAYS));

  return date.toISOString();
}
