import type {
  FinanceDriverOutstanding,
  FinanceShortfall,
} from '@/components/finance/DriverSettlementsPanel';
import { consolidateCashByDriver } from '@/lib/drivers/cash-consolidation';
import { cashCollectableMinor } from '@/lib/finance/cash';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

type CashAgingRow = Database['public']['Functions']['cash_aging']['Returns'][number];
type FinanceOrderRow = {
  assigned_driver_id: string | null;
  cash_collectable_minor: number | null;
  cash_state: string | null;
  created_at: string;
  delivery_fee_minor: number | null;
  id: string;
  order_number: string | null;
  payment_channel_at_delivery: string | null;
  total_amount: number;
  updated_at: string;
};
type AllocationRow = { allocated_minor: number; order_id: string };
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

// États cash où l'argent est déjà passé entre les mains du livreur (= « collecté »),
// alignés sur deriveDriverCashConsolidation (source de vérité).
const COLLECTED_CASH_STATES = new Set(['collected', 'remitted', 'discrepancy']);

function paymentChannelIsCash(channel: string | null): boolean {
  return channel === null || channel === 'ESPECES' || channel === 'INCONNU';
}

// Source UNIQUE de la consolidation versements/écarts par livreur (écran Finances).
// Utilisée par la page RSC ET par l'action de relecture getDriverSettlementsAction :
// après une remise/abandon, le panneau relit EXACTEMENT le même recalcul serveur,
// jamais un recalcul client parallèle → aucun drift (cf. piège matchesOrderSavedView).
//
// Le TOTAL par livreur (outstandingMinor) = cash chez le livreur NET = collecté − frais −
// remis, via le helper partagé consolidateCashByDriver (qui enveloppe deriveDriverCashConsolidation,
// clamp AGRÉGÉ par livreur). Il est donc identique à la page Livreurs, à la card finance_kpis
// (SQL, migration 0065) et au rapport PDF — aucune 4ᵉ surface ne peut diverger.
// Les lignes par commande (orders[]) restent INFORMATIVES : elles montrent le brut encaissé non
// remis par commande (collectable − allocations) ; les frais étant une déduction par livreur (non
// attribuable à une commande), la somme des lignes peut dépasser le total NET de la valeur des frais.
export async function buildDriverSettlements(
  supabase: SupabaseClient<Database>,
  merchantAccountId: string,
): Promise<DriverSettlementsData> {
  const cashAgingRpc = supabase.rpc.bind(supabase) as unknown as (
    fn: 'cash_aging',
    args: { p_merchant: string },
  ) => Promise<{ data: CashAgingRow[] | null; error: unknown }>;

  const [ordersResult, driversResult, shortfallsResult, agingResult] = await Promise.all([
    supabase
      .from('orders')
      .select(
        'id, order_number, total_amount, cash_collectable_minor, delivery_fee_minor, cash_state, payment_channel_at_delivery, assigned_driver_id, created_at, updated_at',
      )
      .eq('merchant_account_id', merchantAccountId)
      .not('assigned_driver_id', 'is', null),
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

  const orderRows = (ordersResult.data ?? []) as FinanceOrderRow[];
  const orderIds = orderRows.map((order) => order.id);
  const allocationsResult =
    orderIds.length > 0
      ? await supabase
          .from('settlement_allocation')
          .select('order_id, allocated_minor')
          .eq('merchant_account_id', merchantAccountId)
          .in('order_id', orderIds)
      : { data: [] as AllocationRow[], error: null };

  const aging = agingResult.data ?? [];
  const allocatedByOrder = new Map<string, number>();
  for (const allocation of (allocationsResult.data ?? []) as AllocationRow[]) {
    allocatedByOrder.set(
      allocation.order_id,
      (allocatedByOrder.get(allocation.order_id) ?? 0) + allocation.allocated_minor,
    );
  }

  // Total NET par livreur (source unique, partagée avec page Livreurs + PDF + card SQL).
  const consolidations = consolidateCashByDriver(
    orderRows
      .filter((order) => order.assigned_driver_id !== null)
      .map((order) => ({
        driverId: order.assigned_driver_id as string,
        orderId: order.id,
        deliveryFeeMinor: order.delivery_fee_minor,
        cashState: order.cash_state,
        cashCollectableMinor: order.cash_collectable_minor,
        paymentChannel: order.payment_channel_at_delivery,
        totalAmount: order.total_amount,
      })),
    allocatedByOrder,
  );

  const driversById = new Map(
    ((driversResult.data ?? []) as DriverRow[]).map((driver) => [driver.id, driver]),
  );
  const agingByDriver = new Map(aging.map((item) => [item.driver_id, item]));
  const outstandingByDriver = new Map<string, FinanceDriverOutstanding>();

  // Un livreur apparaît s'il détient encore du cash NET (collecté − frais − remis > 0).
  for (const [driverId, consolidation] of consolidations) {
    if (consolidation.cashOnHandMinor <= 0) {
      continue;
    }
    const driver = driversById.get(driverId);
    const agingRow = agingByDriver.get(driverId);
    outstandingByDriver.set(driverId, {
      aging: {
        bucket_1_3d: agingRow?.bucket_1_3d ?? 0,
        bucket_gt3d: agingRow?.bucket_gt3d ?? 0,
        bucket_lt1d: agingRow?.bucket_lt1d ?? 0,
      },
      driverId,
      driverName: driver?.full_name ?? 'Livreur',
      driverPhone: driver?.phone ?? '',
      orders: [],
      outstandingMinor: consolidation.cashOnHandMinor,
    });
  }

  // Lignes par commande (informatives) : commandes encaissées non remises, brut par commande.
  for (const order of orderRows) {
    if (!order.assigned_driver_id) {
      continue;
    }
    const entry = outstandingByDriver.get(order.assigned_driver_id);
    if (!entry) {
      continue;
    }
    if (
      !COLLECTED_CASH_STATES.has(order.cash_state ?? '') ||
      !paymentChannelIsCash(order.payment_channel_at_delivery)
    ) {
      continue;
    }
    const collectableMinor = cashCollectableMinor({
      cashCollectableMinor: order.cash_collectable_minor,
      paymentChannel: order.payment_channel_at_delivery,
      totalAmount: order.total_amount,
    });
    const grossOutstanding = Math.max(collectableMinor - (allocatedByOrder.get(order.id) ?? 0), 0);
    if (grossOutstanding <= 0) {
      continue;
    }
    entry.orders.push({
      deliveredAt: order.updated_at ?? order.created_at,
      orderId: order.id,
      orderNumber: order.order_number,
      outstandingMinor: grossOutstanding,
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
