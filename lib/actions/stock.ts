'use server';

import { requireRole } from '@/lib/actions/safe-action';
import { env } from '@/lib/env';
import { parseItemsummary, resolveAndInsertOrderLines } from '@/lib/stock/order-line-resolution';
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

async function getMerchantAccountId(userId: string): Promise<string | null> {
  const supabase = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { data } = await supabase
    .from('merchant_member')
    .select('merchant_account_id')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();
  return data?.merchant_account_id ?? null;
}

// Backfill order_line rows for orders that have none yet (best-effort).
export const backfillOrderLinesAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'stock.backfill_order_lines', section: 'stock' })
  .inputSchema(z.object({}))
  .action(async ({ ctx }) => {
    const admin = createSupabaseAdminClient();
    const merchantAccountId = await getMerchantAccountId(ctx.user.id);
    if (!merchantAccountId) {
      return { ok: false as const, message: 'Compte marchand introuvable.' };
    }

    const { data: orders, error } = await admin
      .from('orders')
      .select('id, items_summary, merchant_account_id')
      .eq('merchant_account_id', merchantAccountId)
      .not('items_summary', 'is', null);

    if (error) return { ok: false as const, message: error.message };

    const { data: existingLines } = await admin
      .from('order_line')
      .select('order_id')
      .eq('merchant_account_id', merchantAccountId);

    const ordersWithLines = new Set((existingLines ?? []).map((l) => l.order_id));

    let processed = 0;
    let failed = 0;

    for (const order of orders ?? []) {
      if (ordersWithLines.has(order.id)) continue;
      const lines = parseItemsummary(order.items_summary);
      if (lines.length === 0) continue;
      try {
        await resolveAndInsertOrderLines(admin, {
          merchantAccountId: order.merchant_account_id,
          orderId: order.id,
          lineItems: lines,
        });
        processed++;
      } catch {
        failed++;
      }
    }

    revalidatePath('/produits');
    return { ok: true as const, processed, failed };
  });

// Records a stock receipt (purchase_in) and recalculates CUMP (atomic via RPC).
export const purchaseInAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'stock.purchase_in', section: 'stock' })
  .inputSchema(
    z.object({
      productId: z.string().uuid(),
      qty: z.number().int().min(1),
      unitCost: z.number().int().min(0),
    }),
  )
  .action(async ({ ctx, parsedInput }) => {
    const post = postStockMovementRpc(ctx.supabase);
    const { error } = await post('post_stock_movement', {
      p_merchant_account_id: ctx.member.merchantAccountId,
      p_product_id: parsedInput.productId,
      p_movement_type: 'purchase_in',
      p_qty: parsedInput.qty,
      p_idempotency_key: `purchase:${parsedInput.productId}:${ctx.user.id}:${Date.now()}`,
      p_created_by: ctx.user.id,
      p_unit_cost: parsedInput.unitCost,
    });

    if (error) return { ok: false as const, message: error.message };
    revalidatePath('/produits');
    return { ok: true as const };
  });

// Records a manual stock adjustment (+/-) with a required reason (atomic via RPC).
export const manualAdjustmentAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'stock.manual_adjustment', section: 'stock' })
  .inputSchema(
    z.object({
      productId: z.string().uuid(),
      qty: z.number().int(),
      reason: z.string().trim().min(3).max(500),
    }),
  )
  .action(async ({ ctx, parsedInput }) => {
    if (parsedInput.qty === 0) {
      return { ok: false as const, message: 'La quantité ne peut pas être 0.' };
    }

    const post = postStockMovementRpc(ctx.supabase);
    const { error } = await post('post_stock_movement', {
      p_merchant_account_id: ctx.member.merchantAccountId,
      p_product_id: parsedInput.productId,
      p_movement_type: 'manual_adjustment',
      p_qty: parsedInput.qty,
      p_idempotency_key: `adj:${parsedInput.productId}:${ctx.user.id}:${Date.now()}`,
      p_created_by: ctx.user.id,
      p_reason: parsedInput.reason,
    });

    if (error) return { ok: false as const, message: error.message };
    revalidatePath('/produits');
    return { ok: true as const };
  });

// Records a courier return — physical return of dispatched stock (atomic via RPC).
export const courierReturnAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'stock.courier_return', section: 'stock' })
  .inputSchema(
    z.object({
      productId: z.string().uuid(),
      qty: z.number().int().min(1),
      orderId: z.string().uuid().optional(),
    }),
  )
  .action(async ({ ctx, parsedInput }) => {
    const post = postStockMovementRpc(ctx.supabase);
    const { error } = await post('post_stock_movement', {
      p_merchant_account_id: ctx.member.merchantAccountId,
      p_product_id: parsedInput.productId,
      p_movement_type: 'courier_return',
      p_qty: parsedInput.qty,
      p_idempotency_key: `return:${parsedInput.productId}:${parsedInput.orderId ?? 'none'}:${ctx.user.id}:${Date.now()}`,
      p_created_by: ctx.user.id,
      p_order_id: parsedInput.orderId,
    });

    if (error) return { ok: false as const, message: error.message };
    revalidatePath('/produits');
    return { ok: true as const };
  });

// Updates the low-stock threshold for a product.
export const setLowStockThresholdAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'stock.set_threshold', section: 'stock' })
  .inputSchema(
    z.object({
      productId: z.string().uuid(),
      threshold: z.number().int().min(0),
    }),
  )
  .action(async ({ ctx, parsedInput }) => {
    const merchantAccountId = await getMerchantAccountId(ctx.user.id);
    if (!merchantAccountId) {
      return { ok: false as const, message: 'Compte marchand introuvable.' };
    }

    const admin = createSupabaseAdminClient();
    const { error } = await admin.from('product_stock').upsert(
      {
        product_id: parsedInput.productId,
        merchant_account_id: merchantAccountId,
        low_stock_threshold: parsedInput.threshold,
      },
      { onConflict: 'product_id' },
    );

    if (error) return { ok: false as const, message: error.message };
    revalidatePath('/produits');
    return { ok: true as const };
  });

export type StockPageRow = {
  productId: string;
  title: string;
  sku: string | null;
  qtyOnHand: number;
  qtyReserved: number;
  qtyAvailable: number;
  lowStockThreshold: number;
  isLowStock: boolean;
  unitCost: number | null;
  stockValue: number | null;
};

export type StockPageData =
  | { ok: true; rows: StockPageRow[]; canSeeCost: boolean }
  | { ok: false; message: string };

export async function getStockPageData(): Promise<StockPageData> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: 'Session introuvable.' };

  const { data: memberAuth } = await supabase
    .from('merchant_member')
    .select('merchant_account_id, role')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();

  if (!memberAuth) return { ok: false, message: 'Compte marchand introuvable.' };

  const { merchant_account_id: merchantAccountId, role } = memberAuth;
  const canSeeCost = role === 'owner' || role === 'manager';

  const admin = createSupabaseAdminClient();

  const { data: products, error: prodError } = await admin
    .from('product')
    .select('id, title, sku')
    .eq('merchant_account_id', merchantAccountId)
    .eq('is_active', true)
    .order('title');

  if (prodError) return { ok: false, message: prodError.message };

  const { data: stocks } = await admin
    .from('product_stock')
    .select('product_id, qty_on_hand, qty_reserved, unit_cost, low_stock_threshold')
    .eq('merchant_account_id', merchantAccountId);

  const stockMap = new Map((stocks ?? []).map((s) => [s.product_id, s]));

  const rows: StockPageRow[] = (products ?? []).map((p) => {
    const s = stockMap.get(p.id);
    const qtyOnHand = s?.qty_on_hand ?? 0;
    const qtyReserved = s?.qty_reserved ?? 0;
    const qtyAvailable = Math.max(0, qtyOnHand - qtyReserved);
    const threshold = s?.low_stock_threshold ?? 10;
    const unitCost = canSeeCost ? (s?.unit_cost ?? 0) : null;
    return {
      productId: p.id,
      title: p.title,
      sku: p.sku,
      qtyOnHand,
      qtyReserved,
      qtyAvailable,
      lowStockThreshold: threshold,
      isLowStock: qtyOnHand <= threshold,
      unitCost,
      stockValue: canSeeCost ? qtyOnHand * (s?.unit_cost ?? 0) : null,
    };
  });

  return { ok: true, rows, canSeeCost };
}
