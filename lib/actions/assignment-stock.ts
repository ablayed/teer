'use server';

// Lot 2 / PR 4 — pendant agent de getDriverAvailableStock (PR 2), pour le check "Stock
// insuffisant" dans TransitionDialog. getDriverAvailableStock (lib/actions/drivers.ts)
// passe par resolveOwnerManagerContext, un gate owner/manager partagé par tout drivers.ts
// (cash, settlements…) — l'élargir à agent exposerait ces données sensibles. Cette action
// est volontairement étroite : client authentifié standard (RLS, pas service-role), lit
// uniquement stock_movement (aucun accès cash/settlement), et réutilise
// driverAvailableStockRows (PR 2, inchangée) — même calcul, même contrat de sortie que
// l'onglet /livreurs, juste une porte d'entrée RBAC différente pour ce cas précis.

import { requireRole } from '@/lib/actions/safe-action';
import { type DriverStockMovement, driverAvailableStockRows } from '@/lib/drivers/stock-on-hand';
import type { Database } from '@/lib/supabase/database.types';
import { getRequestStoreId } from '@/lib/workspace/store';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

type SupabaseServerClient = SupabaseClient<Database>;

function asTypedSupabaseClient(client: unknown): SupabaseServerClient {
  return client as SupabaseServerClient;
}

export type DriverAvailableStockForAssignmentRow = {
  productId: string;
  qtyAvailable: number;
};

export type DriverAvailableStockForAssignmentData =
  | { ok: true; rows: DriverAvailableStockForAssignmentRow[] }
  | { ok: false; errorCode: 'read_failed' };

// Dette connue (identique à getDriverAvailableStock/PR 2, non corrigée ici) : lecture
// stock_movement sans .range()/.limit(), plafond PostgREST max_rows=1000.
export const getDriverAvailableStockForAssignmentAction = requireRole('owner', 'manager', 'agent')
  .metadata({ actionName: 'assignment_stock.driver_available', section: 'orders' })
  .inputSchema(z.object({ driverId: z.string().uuid() }))
  .action(async ({ ctx, parsedInput }) => {
    const supabase = asTypedSupabaseClient(ctx.supabase);
    const shopId = await getRequestStoreId();
    if (!shopId) return { ok: false as const, errorCode: 'read_failed' as const };

    const { data: driverShop, error: driverShopError } = await supabase
      .from('driver_shop')
      .select('driver_id')
      .eq('merchant_account_id', ctx.member.merchantAccountId)
      .eq('shop_id', shopId)
      .eq('driver_id', parsedInput.driverId)
      .maybeSingle();
    if (driverShopError || !driverShop) {
      return { ok: true as const, rows: [] };
    }

    const { data: movements, error } = await supabase
      .from('stock_movement')
      .select('driver_id, product_id, movement_type, qty')
      .eq('merchant_account_id', ctx.member.merchantAccountId)
      .eq('shop_id', shopId)
      .eq('driver_id', parsedInput.driverId);

    if (error) {
      return { ok: false as const, errorCode: 'read_failed' as const };
    }

    const rows = driverAvailableStockRows(
      (movements ?? []) as DriverStockMovement[],
      parsedInput.driverId,
    );

    return {
      ok: true as const,
      rows: rows.map((row) => ({ productId: row.productId, qtyAvailable: row.qtyAvailable })),
    };
  });
