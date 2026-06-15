import type {
  FinanceDriverOutstanding,
  FinanceShortfall,
} from '@/components/finance/DriverSettlementsPanel';
import { cashCollectableMinor } from '@/lib/finance/cash';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

type CashAgingRow = Database['public']['Functions']['cash_aging']['Returns'][number];
type FinanceOrderRow = {
  assigned_driver_id: string | null;
  cash_collectable_minor: number | null;
  created_at: string;
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

function paymentChannelIsCash(channel: string | null): boolean {
  return channel === null || channel === 'ESPECES' || channel === 'INCONNU';
}

// Source UNIQUE de la consolidation versements/écarts par livreur (écran Finances).
// Utilisée par la page RSC ET par l'action de relecture getDriverSettlementsAction :
// après une remise/abandon, le panneau relit EXACTEMENT le même recalcul serveur,
// jamais un recalcul client parallèle → aucun drift (cf. piège matchesOrderSavedView).
export async function buildDriverSettlements(
  supabase: SupabaseClient<Database>,
  merchantAccountId: string,
): Promise<DriverSettlementsData> {
  const cashAgingRpc = supabase.rpc.bind(supabase) as unknown as (
    fn: 'cash_aging',
    args: { p_merchant: string },
  ) => Promise<{ data: CashAgingRow[] | null; error: unknown }>;

  const [outstandingOrdersResult, driversResult, shortfallsResult, agingResult] = await Promise.all(
    [
      supabase
        .from('orders')
        .select(
          'id, order_number, total_amount, cash_collectable_minor, payment_channel_at_delivery, assigned_driver_id, created_at, updated_at',
        )
        .eq('merchant_account_id', merchantAccountId)
        .eq('cod_status', 'LIVREE')
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
    ],
  );

  const outstandingRows = ((outstandingOrdersResult.data ?? []) as FinanceOrderRow[]).filter(
    (order) => paymentChannelIsCash(order.payment_channel_at_delivery),
  );
  const outstandingOrderIds = outstandingRows.map((order) => order.id);
  const allocationsResult =
    outstandingOrderIds.length > 0
      ? await supabase
          .from('settlement_allocation')
          .select('order_id, allocated_minor')
          .eq('merchant_account_id', merchantAccountId)
          .in('order_id', outstandingOrderIds)
      : { data: [] as AllocationRow[], error: null };

  const aging = agingResult.data ?? [];
  const allocatedByOrder = new Map<string, number>();
  for (const allocation of (allocationsResult.data ?? []) as AllocationRow[]) {
    allocatedByOrder.set(
      allocation.order_id,
      (allocatedByOrder.get(allocation.order_id) ?? 0) + allocation.allocated_minor,
    );
  }

  const driversById = new Map(
    ((driversResult.data ?? []) as DriverRow[]).map((driver) => [driver.id, driver]),
  );
  const agingByDriver = new Map(aging.map((item) => [item.driver_id, item]));
  const outstandingByDriver = new Map<string, FinanceDriverOutstanding>();

  for (const order of outstandingRows) {
    if (!order.assigned_driver_id) {
      continue;
    }

    const collectableMinor = cashCollectableMinor({
      cashCollectableMinor: order.cash_collectable_minor,
      paymentChannel: order.payment_channel_at_delivery,
      totalAmount: order.total_amount,
    });
    const outstandingMinor = Math.max(collectableMinor - (allocatedByOrder.get(order.id) ?? 0), 0);

    if (outstandingMinor <= 0) {
      continue;
    }

    const driver = driversById.get(order.assigned_driver_id);
    const agingRow = agingByDriver.get(order.assigned_driver_id);
    const current = outstandingByDriver.get(order.assigned_driver_id) ?? {
      aging: {
        bucket_1_3d: agingRow?.bucket_1_3d ?? 0,
        bucket_gt3d: agingRow?.bucket_gt3d ?? 0,
        bucket_lt1d: agingRow?.bucket_lt1d ?? 0,
      },
      driverId: order.assigned_driver_id,
      driverName: driver?.full_name ?? 'Livreur',
      driverPhone: driver?.phone ?? '',
      orders: [],
      outstandingMinor: 0,
    };

    current.orders.push({
      deliveredAt: order.updated_at ?? order.created_at,
      orderId: order.id,
      orderNumber: order.order_number,
      outstandingMinor,
    });
    current.outstandingMinor += outstandingMinor;
    outstandingByDriver.set(order.assigned_driver_id, current);
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
