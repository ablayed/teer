import type {
  FinanceDriverOutstanding,
  FinanceShortfall,
} from '@/components/finance/DriverSettlementsPanel';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

type CashAgingRow = Database['public']['Functions']['cash_aging']['Returns'][number];
type DriverRow = { full_name: string; id: string; phone: string };
type ShortfallRow = {
  driver_id: string;
  id: string;
  reason: string | null;
  shortfall_minor: number;
};

export type DriverSettlementsData = {
  drivers: FinanceDriverOutstanding[];
  shortfalls: FinanceShortfall[];
};

// Source UNIQUE de la consolidation versements/écarts par livreur (écran Finances).
// Utilisée par la page RSC ET par l'action de relecture getDriverSettlementsAction :
// après une remise/abandon, le panneau relit EXACTEMENT le même recalcul serveur,
// jamais un recalcul client parallèle → aucun drift (cf. piège matchesOrderSavedView).
//
// Le TOTAL par livreur (outstandingMinor) = cash chez le livreur NET = collecté − frais −
// remis, via la RPC get_driver_cash_consolidation (migration 0083), qui porte la même
// arithmétique agrégée que deriveDriverCashConsolidation/consolidateCashByDriver — clamp
// AGRÉGÉ par livreur. Il est donc identique à la page Livreurs et à la card finance_kpis
// (SQL, migration 0065) — aucune 3ᵉ surface ne peut diverger. Plus de select `orders`
// all-time ni de `.in(orderIds)` sur settlement_allocation (cap PostgREST 1000 / URL, #56/#50).
//
// Les lignes par commande (orders[]) restent INFORMATIVES : elles montrent le brut encaissé non
// remis par commande (collectable − allocations), via la RPC get_driver_cash_outstanding_orders
// (même migration), qui applique déjà la garde "livreur avec cash NET > 0" côté SQL. Les frais
// étant une déduction par livreur (non attribuable à une commande), la somme des lignes peut
// dépasser le total NET de la valeur des frais — comportement inchangé.
export async function buildDriverSettlements(
  supabase: SupabaseClient<Database>,
  merchantAccountId: string,
): Promise<DriverSettlementsData> {
  const cashAgingRpc = supabase.rpc.bind(supabase) as unknown as (
    fn: 'cash_aging',
    args: { p_merchant: string },
  ) => Promise<{ data: CashAgingRow[] | null; error: unknown }>;

  const [
    consolidationResult,
    outstandingOrdersResult,
    driversResult,
    shortfallsResult,
    agingResult,
  ] = await Promise.all([
    supabase.rpc('get_driver_cash_consolidation', { p_merchant_id: merchantAccountId }),
    supabase.rpc('get_driver_cash_outstanding_orders', { p_merchant_id: merchantAccountId }),
    supabase
      .from('driver')
      .select('id, full_name, phone')
      .eq('merchant_account_id', merchantAccountId),
    supabase
      .from('settlement_shortfall')
      .select('id, driver_id, reason, shortfall_minor')
      .eq('merchant_account_id', merchantAccountId)
      .eq('resolution', 'ROLLED_FORWARD'),
    cashAgingRpc('cash_aging', { p_merchant: merchantAccountId }),
  ]);

  const consolidationRows = consolidationResult.data ?? [];
  const outstandingOrderRows = outstandingOrdersResult.data ?? [];
  const aging = agingResult.data ?? [];
  const driversById = new Map(
    ((driversResult.data ?? []) as DriverRow[]).map((driver) => [driver.id, driver]),
  );
  const agingByDriver = new Map(aging.map((item) => [item.driver_id, item]));
  const outstandingByDriver = new Map<string, FinanceDriverOutstanding>();

  // Un livreur apparaît s'il détient encore du cash NET (collecté − frais − remis > 0).
  for (const row of consolidationRows) {
    if (row.cash_on_hand_minor <= 0) {
      continue;
    }
    const driver = driversById.get(row.driver_id);
    const agingRow = agingByDriver.get(row.driver_id);
    outstandingByDriver.set(row.driver_id, {
      aging: {
        bucket_1_3d: agingRow?.bucket_1_3d ?? 0,
        bucket_gt3d: agingRow?.bucket_gt3d ?? 0,
        bucket_lt1d: agingRow?.bucket_lt1d ?? 0,
      },
      driverId: row.driver_id,
      driverName: driver?.full_name ?? row.driver_name ?? 'Livreur',
      driverPhone: driver?.phone ?? '',
      orders: [],
      outstandingMinor: row.cash_on_hand_minor,
    });
  }

  // Lignes par commande (informatives) : commandes encaissées non remises, brut par commande —
  // la RPC ne renvoie déjà que les commandes des livreurs avec cash NET > 0 (garde reproduite
  // côté SQL) ; le `if (!entry) continue` reste une garde défensive, pas le filtre principal.
  for (const row of outstandingOrderRows) {
    const entry = outstandingByDriver.get(row.driver_id);
    if (!entry) {
      continue;
    }
    entry.orders.push({
      deliveredAt: row.delivered_at,
      orderId: row.order_id,
      orderNumber: row.order_number,
      outstandingMinor: row.outstanding_minor,
    });
  }

  const drivers = [...outstandingByDriver.values()].sort(
    (left, right) => right.outstandingMinor - left.outstandingMinor,
  );
  const shortfallRows = (shortfallsResult.data ?? []) as ShortfallRow[];
  const shortfalls: FinanceShortfall[] = shortfallRows.map((shortfall) => ({
    driverId: shortfall.driver_id,
    driverName: driversById.get(shortfall.driver_id)?.full_name ?? 'Livreur',
    id: shortfall.id,
    reason: shortfall.reason,
    shortfallMinor: shortfall.shortfall_minor,
  }));

  return { drivers, shortfalls };
}
