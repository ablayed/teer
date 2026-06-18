'use server';

import { requireRole } from '@/lib/actions/safe-action';
import {
  type DriverCashConsolidation,
  consolidateCashByDriver,
  deriveDriverCashConsolidation,
} from '@/lib/drivers/cash-consolidation';
import { type DriverPerformance, deriveDriverPerformance } from '@/lib/drivers/performance';
import { type DriverStockMovement, driverStockRows } from '@/lib/drivers/stock-on-hand';
import { env } from '@/lib/env';
import type { Database } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

type PostStockMovementArgs = Database['public']['Functions']['post_stock_movement']['Args'];

function postStockMovementRpc(client: { rpc: SupabaseClient<Database>['rpc'] }) {
  return client.rpc.bind(client) as unknown as (
    fn: 'post_stock_movement',
    args: PostStockMovementArgs,
  ) => Promise<{ data: string | null; error: { message: string } | null }>;
}

function createSupabaseAdminClient() {
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
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
    const post = postStockMovementRpc(ctx.supabase);
    const { error } = await post('post_stock_movement', {
      p_merchant_account_id: ctx.member.merchantAccountId,
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
    const post = postStockMovementRpc(ctx.supabase);
    const { error } = await post('post_stock_movement', {
      p_merchant_account_id: ctx.member.merchantAccountId,
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

// Résout les noms d'auteur (created_by) via l'auth admin, dédupliqués. Few authors
// en pratique (owner + managers) → un getUserById par id distinct suffit.
async function resolveAuthorNames(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  userIds: (string | null)[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const distinct = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  await Promise.all(
    distinct.map(async (id) => {
      const { data } = await admin.auth.admin.getUserById(id);
      const meta = (data.user?.user_metadata ?? {}) as Record<string, unknown>;
      const fromMeta =
        (typeof meta.full_name === 'string' && meta.full_name) ||
        (typeof meta.name === 'string' && meta.name) ||
        '';
      names.set(id, fromMeta || data.user?.email || 'Inconnu');
    }),
  );
  return names;
}

export type SettlementHistoryRow = {
  id: string;
  settledAt: string; // ISO
  amountMinor: number; // peut être négatif (reprise de retour, 0056)
  method: string;
  driverId: string | null;
  driverName: string;
  authorName: string;
};

export type SettlementHistoryData =
  | { ok: true; rows: SettlementHistoryRow[] }
  | { ok: false; message: string };

type RawSettlementRow = {
  id: string;
  driver_id: string | null;
  amount_received_minor: number;
  method: string;
  settled_at: string;
  created_by: string | null;
};

// Construit l'historique des versements depuis cash_settlement (trié par date desc),
// avec nom du livreur et auteur résolus. Owner/manager. `driverId` null = tous livreurs.
async function buildSettlementHistory(driverId: string | null): Promise<SettlementHistoryData> {
  const auth = await resolveOwnerManagerContext();
  if (!auth.ok) return { ok: false, message: auth.message };
  const { merchantAccountId, admin } = auth;

  let query = admin
    .from('cash_settlement')
    .select('id, driver_id, amount_received_minor, method, settled_at, created_by')
    .eq('merchant_account_id', merchantAccountId)
    .order('settled_at', { ascending: false });
  if (driverId) query = query.eq('driver_id', driverId);

  const { data, error } = await query;
  if (error) return { ok: false, message: error.message };

  const settlements = (data ?? []) as RawSettlementRow[];
  if (settlements.length === 0) return { ok: true, rows: [] };

  const driverIds = [...new Set(settlements.map((s) => s.driver_id).filter(Boolean))] as string[];
  const { data: drivers } = await admin
    .from('driver')
    .select('id, full_name')
    .eq('merchant_account_id', merchantAccountId)
    .in('id', driverIds.length > 0 ? driverIds : ['00000000-0000-0000-0000-000000000000']);
  const driverNames = new Map((drivers ?? []).map((d) => [d.id, d.full_name]));

  const authorNames = await resolveAuthorNames(
    admin,
    settlements.map((s) => s.created_by),
  );

  const rows: SettlementHistoryRow[] = settlements.map((s) => ({
    id: s.id,
    settledAt: s.settled_at,
    amountMinor: s.amount_received_minor,
    method: s.method,
    driverId: s.driver_id,
    driverName: (s.driver_id && driverNames.get(s.driver_id)) || 'Livreur',
    authorName: (s.created_by && authorNames.get(s.created_by)) || 'Inconnu',
  }));

  return { ok: true, rows };
}

// Historique des versements d'un livreur (owner/manager).
export async function getDriverSettlementHistory(driverId: string): Promise<SettlementHistoryData> {
  return buildSettlementHistory(driverId);
}

// Historique global des versements, tous livreurs consolidés (owner/manager).
export async function getAllSettlementHistory(): Promise<SettlementHistoryData> {
  return buildSettlementHistory(null);
}

export type DriversCashTotal =
  | { ok: true; totalMinor: number; driverCount: number }
  | { ok: false; message: string };

// Cash total « à remettre » chez TOUS les livreurs = Σ cashOnHand par livreur
// (collecté − frais encaissés − remis), via la même dérivation que le panneau
// Livreurs (deriveDriverCashConsolidation) → aucun chiffre dupliqué. Owner/manager.
export async function getDriversCashOnHandTotal(): Promise<DriversCashTotal> {
  const auth = await resolveOwnerManagerContext();
  if (!auth.ok) return { ok: false, message: auth.message };
  const { merchantAccountId, admin } = auth;

  const { data: orders, error } = await admin
    .from('orders')
    .select(
      'id, assigned_driver_id, cash_state, cash_collectable_minor, delivery_fee_minor, payment_channel_at_delivery, total_amount',
    )
    .eq('merchant_account_id', merchantAccountId)
    .not('assigned_driver_id', 'is', null);
  if (error) return { ok: false, message: error.message };

  const rows = orders ?? [];
  const orderIds = rows.map((o) => o.id);

  const allocationsResult =
    orderIds.length > 0
      ? await admin
          .from('settlement_allocation')
          .select('order_id, allocated_minor')
          .eq('merchant_account_id', merchantAccountId)
          .in('order_id', orderIds)
      : { data: [] as { order_id: string; allocated_minor: number }[], error: null };
  if (allocationsResult.error) return { ok: false, message: allocationsResult.error.message };

  const allocatedByOrder = new Map<string, number>();
  for (const a of allocationsResult.data ?? []) {
    allocatedByOrder.set(a.order_id, (allocatedByOrder.get(a.order_id) ?? 0) + a.allocated_minor);
  }

  const consolidations = consolidateCashByDriver(
    rows.map((o) => ({
      driverId: o.assigned_driver_id as string,
      orderId: o.id,
      deliveryFeeMinor: o.delivery_fee_minor,
      cashState: o.cash_state,
      cashCollectableMinor: o.cash_collectable_minor,
      paymentChannel: o.payment_channel_at_delivery,
      totalAmount: o.total_amount,
    })),
    allocatedByOrder,
  );

  let totalMinor = 0;
  let driverCount = 0;
  for (const consolidation of consolidations.values()) {
    totalMinor += consolidation.cashOnHandMinor;
    if (consolidation.cashOnHandMinor > 0) driverCount += 1;
  }

  return { ok: true, totalMinor, driverCount };
}
