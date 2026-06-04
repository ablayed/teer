'use server';

import { requireRole } from '@/lib/actions/safe-action';
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
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

function createSupabaseAdminClient() {
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function getMerchantAccountId(userId: string): Promise<string | null> {
  const admin = createSupabaseAdminClient();
  const { data } = await admin
    .from('merchant_member')
    .select('merchant_account_id')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();
  return data?.merchant_account_id ?? null;
}

// Allocates an advance lot of a product to a courier (lot d'avance).
// Stock physically leaves the warehouse → qty_on_hand decremented, attributed
// to the driver, outside any order. Atomic via post_stock_movement.
export const allocateToCourierAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'drivers.allocate_to_courier', section: 'drivers' })
  .inputSchema(
    z.object({
      driverId: z.string().uuid(),
      productId: z.string().uuid(),
      qty: z.number().int().min(1),
      clientRequestId: z.string().uuid(),
    }),
  )
  .action(async ({ ctx, parsedInput }) => {
    const merchantAccountId = await getMerchantAccountId(ctx.user.id);
    if (!merchantAccountId) {
      return { ok: false as const, message: 'Compte marchand introuvable.' };
    }

    const admin = createSupabaseAdminClient();
    const { error } = await admin.rpc('post_stock_movement', {
      p_merchant_account_id: merchantAccountId,
      p_product_id: parsedInput.productId,
      p_movement_type: 'allocate_to_courier',
      p_qty: -parsedInput.qty,
      p_idempotency_key: `lot_alloc:${parsedInput.driverId}:${parsedInput.productId}:${parsedInput.clientRequestId}`,
      p_created_by: ctx.user.id,
      p_driver_id: parsedInput.driverId,
    });

    if (error) return { ok: false as const, message: error.message };
    revalidatePath('/livreurs');
    revalidatePath('/produits');
    return { ok: true as const };
  });

// Records the return of an unsold lot from a courier (retour de lot).
// Stock comes back to the warehouse → qty_on_hand incremented, attributed to
// the driver, outside any order. Atomic via post_stock_movement.
export const courierReturnLotAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'drivers.courier_return_lot', section: 'drivers' })
  .inputSchema(
    z.object({
      driverId: z.string().uuid(),
      productId: z.string().uuid(),
      qty: z.number().int().min(1),
      clientRequestId: z.string().uuid(),
    }),
  )
  .action(async ({ ctx, parsedInput }) => {
    const merchantAccountId = await getMerchantAccountId(ctx.user.id);
    if (!merchantAccountId) {
      return { ok: false as const, message: 'Compte marchand introuvable.' };
    }

    const admin = createSupabaseAdminClient();
    const { error } = await admin.rpc('post_stock_movement', {
      p_merchant_account_id: merchantAccountId,
      p_product_id: parsedInput.productId,
      p_movement_type: 'courier_return_lot',
      p_qty: parsedInput.qty,
      p_idempotency_key: `lot_return:${parsedInput.driverId}:${parsedInput.productId}:${parsedInput.clientRequestId}`,
      p_created_by: ctx.user.id,
      p_driver_id: parsedInput.driverId,
    });

    if (error) return { ok: false as const, message: error.message };
    revalidatePath('/livreurs');
    revalidatePath('/produits');
    return { ok: true as const };
  });

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
    .select('id, cash_state, cash_collectable_minor, payment_channel_at_delivery, total_amount')
    .eq('merchant_account_id', merchantAccountId)
    .eq('assigned_driver_id', driverId);

  if (ordersError) return { ok: false, message: ordersError.message };

  const orderIds = (orders ?? []).map((o) => o.id);

  const [allocationsResult, shortfallsResult] = await Promise.all([
    orderIds.length > 0
      ? admin
          .from('settlement_allocation')
          .select('allocated_minor')
          .eq('merchant_account_id', merchantAccountId)
          .in('order_id', orderIds)
      : Promise.resolve({ data: [] as { allocated_minor: number }[], error: null }),
    admin
      .from('settlement_shortfall')
      .select('shortfall_minor, resolution')
      .eq('merchant_account_id', merchantAccountId)
      .eq('driver_id', driverId),
  ]);

  if (allocationsResult.error) return { ok: false, message: allocationsResult.error.message };
  if (shortfallsResult.error) return { ok: false, message: shortfallsResult.error.message };

  const remittedMinor = (allocationsResult.data ?? []).reduce(
    (total, a) => total + a.allocated_minor,
    0,
  );

  const consolidation = deriveDriverCashConsolidation({
    orders: (orders ?? []).map((o) => ({
      cashState: o.cash_state,
      cashCollectableMinor: o.cash_collectable_minor,
      paymentChannel: o.payment_channel_at_delivery,
      totalAmount: o.total_amount,
    })),
    remittedMinor,
    shortfalls: (shortfallsResult.data ?? []).map((s) => ({
      shortfallMinor: s.shortfall_minor ?? 0,
      resolution: s.resolution,
    })),
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
