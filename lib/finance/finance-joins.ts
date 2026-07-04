// Lot 5 (migration 0087) — jointures orders×stock_movement/order_line pour les rapports
// finance/marge/P&L, extraites de report-data.ts pour ne PAS forcer product-cost.ts/
// driver-cost.ts à charger lib/env.ts (créer le client admin exige des vars serveur — les
// tests unitaires de computeFinanceProductCostReport/computeFinanceDriverCostReport
// n'instancient jamais de client et n'ont pas ces vars). Aucune dépendance à `env` ici :
// le client admin est toujours construit ailleurs (createFinanceAdminClient) et passé en
// paramètre.
import type { FinanceAdminClient } from '@/lib/finance/report-data';

// Contrat de sortie exact des RPC get_finance_collected_joins / get_finance_returned_joins
// (jsonb, jamais `returns table` : `max_rows=1000` s'applique aussi en sortie des RPC
// `returns table`/`setof`, cf. commentaire de la migration 0087). Les clés sont TOUJOURS des
// tableaux ([] si vide, jamais null), même contrat que get_loss_analytics_joins (0078).
export type FinanceSoldMovementJoinRow = {
  order_id: string | null;
  product_id: string;
  driver_id: string | null;
  qty: number;
  unit_cost: number | null;
};

export type FinanceOrderLineJoinRow = {
  order_id: string;
  product_id: string | null;
  raw_title: string;
  qty: number;
};

export type FinanceCourierReturnJoinRow = {
  order_id: string | null;
  product_id: string;
  qty: number;
};

type FinanceCollectedJoinsPayload = {
  soldMovements: FinanceSoldMovementJoinRow[];
  orderLines: FinanceOrderLineJoinRow[];
};

type FinanceReturnedJoinsPayload = {
  soldMovements: Array<Omit<FinanceSoldMovementJoinRow, 'driver_id'>>;
  courierReturns: FinanceCourierReturnJoinRow[];
};

// Fenêtre orders.cash_collected_at ∈ [fromIso,toIso] + shop optionnel, jointe côté SQL à
// stock_movement (sold) et order_line — remplace les anciens fetchSoldMovements/orderIds
// .in() (jusqu'à ~1000 UUID en URL, classe 400 #50). RPC PARTAGÉE par report-data.ts,
// product-cost.ts et driver-cost.ts (chacun projette les colonnes dont il a besoin).
export async function fetchFinanceCollectedJoins(
  admin: FinanceAdminClient,
  merchantId: string,
  fromIso: string,
  toIso: string,
  shopId?: string | null,
): Promise<FinanceCollectedJoinsPayload> {
  const { data, error } = await admin.rpc('get_finance_collected_joins', {
    p_from: fromIso,
    p_merchant_id: merchantId,
    p_shop_id: shopId ?? undefined,
    p_to: toIso,
  });
  if (error) throw new Error('finance_collected_joins_error');
  return data as unknown as FinanceCollectedJoinsPayload;
}

// Fenêtre orders.returned_at ∈ [fromIso,toIso] AND cash_collected_at IS NOT NULL (contra-
// revenue réel) + shop optionnel, jointe côté SQL à stock_movement (sold + courier_return).
// Utilisée uniquement par report-data.ts.
export async function fetchFinanceReturnedJoins(
  admin: FinanceAdminClient,
  merchantId: string,
  fromIso: string,
  toIso: string,
  shopId?: string | null,
): Promise<FinanceReturnedJoinsPayload> {
  const { data, error } = await admin.rpc('get_finance_returned_joins', {
    p_from: fromIso,
    p_merchant_id: merchantId,
    p_shop_id: shopId ?? undefined,
    p_to: toIso,
  });
  if (error) throw new Error('finance_returned_joins_error');
  return data as unknown as FinanceReturnedJoinsPayload;
}

export const CAPPED_READ_PAGE_SIZE = 500;

// PostgREST plafonne silencieusement tout select sans .range()/.limit() à max_rows=1000
// (supabase/config.toml:8, cf. Lot 5). Pagine en boucle par paquets de 500 avec un ordre
// stable sur `id` (même pattern que fetchAllPages/loss-analytics.ts, Bug 2 #50).
export async function fetchAllPages<Row>(
  queryPage: (
    offset: number,
  ) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>,
): Promise<{ data: Row[]; error: { message: string } | null }> {
  const rows: Row[] = [];

  for (let offset = 0; ; offset += CAPPED_READ_PAGE_SIZE) {
    const { data, error } = await queryPage(offset);

    if (error) {
      return { data: rows, error };
    }

    const batch = data ?? [];
    rows.push(...batch);

    if (batch.length < CAPPED_READ_PAGE_SIZE) {
      break;
    }
  }

  return { data: rows, error: null };
}
