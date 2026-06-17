'use server';

import {
  type DriverCashConsolidation,
  deriveDriverCashConsolidation,
} from '@/lib/drivers/cash-consolidation';
import { type DriverPerformance, deriveDriverPerformance } from '@/lib/drivers/performance';
import { type DriverStockMovement, driverStockRows } from '@/lib/drivers/stock-on-hand';
import { env } from '@/lib/env';
import type { Database } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createClient } from '@supabase/supabase-js';

// Phase 12 : le mode « lot d'avance » est retiré — les actions allocateToCourierAction
// et courierReturnLotAction n'existent plus. Le stock en main reste géré PAR COMMANDE
// (dispatch / courier_return via transition_order). Les types lot demeurent inertes en
// base (historique lisible, non créable).

function createSupabaseAdminClient() {
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export type ActiveDriverOption = { id: string; fullName: string };

// Lists the tenant's active drivers for the assignment selector (RLS-scoped via
// the server client — driver_select allows owner/manager/agent). Read-only, used
// from RSC; returns [] on error so the UI degrades to "aucun livreur actif".
export async function getActiveDrivers(): Promise<ActiveDriverOption[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('driver')
    .select('id, full_name')
    .eq('is_active', true)
    .order('full_name', { ascending: true });

  if (error || !data) {
    return [];
  }

  const rows = data as { id: string; full_name: string }[];
  return rows.map((driver) => ({ id: driver.id, fullName: driver.full_name }));
}

export type DriverStockRow = {
  productId: string;
  title: string;
  sku: string | null;
  qtyOnHand: number;
};

export type DriverStockData = { ok: true; rows: DriverStockRow[] } | { ok: false; message: string };

// Resolves the current owner/manager context (auth via server client, data via admin).
type OwnerManagerContext =
  | { ok: true; merchantAccountId: string; admin: ReturnType<typeof createSupabaseAdminClient> }
  | { ok: false; message: string };

async function resolveOwnerManagerContext(): Promise<OwnerManagerContext> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: 'Session introuvable.' };

  const admin = createSupabaseAdminClient();
  const { data: memberAuth } = await admin
    .from('merchant_member')
    .select('merchant_account_id, role')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();

  if (!memberAuth) return { ok: false, message: 'Compte marchand introuvable.' };
  if (memberAuth.role !== 'owner' && memberAuth.role !== 'manager') {
    return { ok: false, message: 'Accès refusé.' };
  }

  return { ok: true, merchantAccountId: memberAuth.merchant_account_id, admin };
}

// Derives the courier's stock-in-hand per product from the ledger (owner/manager only).
export async function getDriverStockOnHand(driverId: string): Promise<DriverStockData> {
  const auth = await resolveOwnerManagerContext();
  if (!auth.ok) return { ok: false, message: auth.message };
  const { merchantAccountId, admin } = auth;

  const { data: movements, error } = await admin
    .from('stock_movement')
    .select('driver_id, product_id, movement_type, qty')
    .eq('merchant_account_id', merchantAccountId)
    .eq('driver_id', driverId);

  if (error) return { ok: false, message: error.message };

  const positions = driverStockRows((movements ?? []) as DriverStockMovement[], driverId).filter(
    (r) => r.qtyOnHand > 0,
  );

  if (positions.length === 0) return { ok: true, rows: [] };

  const { data: products } = await admin
    .from('product')
    .select('id, title, sku')
    .eq('merchant_account_id', merchantAccountId)
    .in(
      'id',
      positions.map((p) => p.productId),
    );

  const productMap = new Map((products ?? []).map((p) => [p.id, p]));

  const rows: DriverStockRow[] = positions
    .map((p) => {
      const product = productMap.get(p.productId);
      return {
        productId: p.productId,
        title: product?.title ?? 'Produit inconnu',
        sku: product?.sku ?? null,
        qtyOnHand: p.qtyOnHand,
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title, 'fr'));

  return { ok: true, rows };
}

export type DriverCashData =
  | { ok: true; consolidation: DriverCashConsolidation }
  | { ok: false; message: string };

// Consolidates cash per driver (dû/collecté/remis/écart) by reusing the existing
// cash tables and the dimensional cash_state. Owner/manager only.
export async function getDriverCashConsolidation(driverId: string): Promise<DriverCashData> {
  const auth = await resolveOwnerManagerContext();
  if (!auth.ok) return { ok: false, message: auth.message };
  const { merchantAccountId, admin } = auth;

  const { data: orders, error: ordersError } = await admin
    .from('orders')
    .select(
      'id, cash_state, cash_collectable_minor, delivery_fee_minor, payment_channel_at_delivery, total_amount',
    )
    .eq('merchant_account_id', merchantAccountId)
    .eq('assigned_driver_id', driverId);

  if (ordersError) return { ok: false, message: ordersError.message };

  const orderIds = (orders ?? []).map((o) => o.id);

  // « remis » = Σ allocations ; l'écart est dérivé du live (collecté − remis),
  // pas d'une ligne settlement_shortfall figée → plus besoin de la requête.
  const allocationsResult =
    orderIds.length > 0
      ? await admin
          .from('settlement_allocation')
          .select('allocated_minor')
          .eq('merchant_account_id', merchantAccountId)
          .in('order_id', orderIds)
      : { data: [] as { allocated_minor: number }[], error: null };

  if (allocationsResult.error) return { ok: false, message: allocationsResult.error.message };

  const remittedMinor = (allocationsResult.data ?? []).reduce(
    (total, a) => total + a.allocated_minor,
    0,
  );

  const consolidation = deriveDriverCashConsolidation({
    orders: (orders ?? []).map((o) => ({
      deliveryFeeMinor: o.delivery_fee_minor,
      cashState: o.cash_state,
      cashCollectableMinor: o.cash_collectable_minor,
      paymentChannel: o.payment_channel_at_delivery,
      totalAmount: o.total_amount,
    })),
    remittedMinor,
  });

  return { ok: true, consolidation };
}

export type DriverPerformanceData =
  | { ok: true; performance: DriverPerformance }
  | { ok: false; message: string };

// Per-driver performance over a period (created_at in [from, to)). Owner/manager only.
export async function getDriverPerformance(
  driverId: string,
  period: { from: string; to: string },
): Promise<DriverPerformanceData> {
  const auth = await resolveOwnerManagerContext();
  if (!auth.ok) return { ok: false, message: auth.message };
  const { merchantAccountId, admin } = auth;

  const { data: orders, error } = await admin
    .from('orders')
    .select(
      'cod_status, cash_state, cash_collectable_minor, payment_channel_at_delivery, total_amount',
    )
    .eq('merchant_account_id', merchantAccountId)
    .eq('assigned_driver_id', driverId)
    .gte('created_at', period.from)
    .lt('created_at', period.to);

  if (error) return { ok: false, message: error.message };

  const performance = deriveDriverPerformance(
    (orders ?? []).map((o) => ({
      codStatus: o.cod_status,
      cashState: o.cash_state,
      cashCollectableMinor: o.cash_collectable_minor,
      paymentChannel: o.payment_channel_at_delivery,
      totalAmount: o.total_amount,
    })),
  );

  return { ok: true, performance };
}
