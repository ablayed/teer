'use server';

import { requireRole } from '@/lib/actions/safe-action';
import { type LossAnalyticsReliability, computeLossAnalytics } from '@/lib/loss-analytics/metrics';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

type SupabaseServerClient = SupabaseClient<Database>;
type RepeatedRefuserRow =
  Database['public']['Functions']['list_repeated_refusers']['Returns'][number];

const periodSchema = z.object({
  from: z.string().datetime(),
  shopId: z.string().uuid().nullable().optional(),
  to: z.string().datetime(),
});

function asTypedSupabaseClient(client: unknown): SupabaseServerClient {
  return client as SupabaseServerClient;
}

function toReliability(row: RepeatedRefuserRow): LossAnalyticsReliability {
  return {
    customerId: row.customer_id,
    fullName: row.full_name ?? null,
    orderCount: row.order_count,
    refusedCount: row.refused_count,
    score: row.score,
    tier: row.tier,
  };
}

function isNonEmptyString(value: string | null): value is string {
  return typeof value === 'string' && value.length > 0;
}

// Bug 1 fix de fond : RPC dédiée list_repeated_refusers (0077). Elle pré-filtre côté SQL
// les clients à refused_count >= 2 puis ne score QUE ceux-là (lateral O(N_refuseurs) au
// lieu de O(N_clients) sur list_customer_reliability) => plus de timeout 503 sur gros
// compte. Sémantique refused_count identique (get_customer_reliability), tri déterministe,
// tenant-scopée, security invoker via ctx.supabase (client session, respecte RLS).
// Le filtre `>= 2` et le tri de computeLossAnalytics restent en place : idempotents ici
// (la RPC renvoie déjà les mêmes lignes filtrées/triées) — aucun changement de contrat.
async function listRepeatedRefusers(
  supabase: SupabaseServerClient,
  merchantId: string,
): Promise<{ data: LossAnalyticsReliability[]; error: string | null }> {
  const result = await supabase.rpc('list_repeated_refusers', {
    p_limit: 100,
    p_merchant_id: merchantId,
  });

  if (result.error) {
    return { data: [], error: result.error.message };
  }

  return { data: (result.data ?? []).map(toReliability), error: null };
}

export const getLossAnalyticsAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'analytics.loss.get', section: 'analytics' })
  .inputSchema(periodSchema)
  .action(async ({ ctx, parsedInput }) => {
    const supabase = asTypedSupabaseClient(ctx.supabase);
    const merchantId = ctx.member.merchantAccountId;
    const { from, shopId, to } = parsedInput;

    let ordersQuery = supabase
      .from('orders')
      .select(
        'id, source, customer_id, assigned_driver_id, order_state, delivery_state, cancel_reason, created_at, returned_at',
      )
      .eq('merchant_account_id', merchantId)
      .gte('created_at', from)
      .lte('created_at', to);

    if (shopId) {
      ordersQuery = ordersQuery.eq('shop_id', shopId);
    }

    const [ordersResult, auditResult, reliabilityResult] = await Promise.all([
      ordersQuery,
      supabase
        .from('audit_log')
        .select('resource_id, payload, created_at')
        .eq('merchant_account_id', merchantId)
        .eq('action', 'order.transition')
        .eq('resource_type', 'orders')
        .gte('created_at', from)
        .lte('created_at', to),
      listRepeatedRefusers(supabase, merchantId),
    ]);

    if (ordersResult.error || auditResult.error || reliabilityResult.error) {
      // DIAG (temporaire, branche diag/analyses-error-logging) : identifier QUELLE
      // requête du bloc 1 échoue. Ne change PAS la logique de retour.
      // biome-ignore lint/suspicious/noConsole: diagnostic temporaire (branche diag)
      console.error(
        '[loss-analytics] bloc 1 échec',
        JSON.stringify({
          merchantId,
          orders: ordersResult.error
            ? {
                message: ordersResult.error.message,
                code: ordersResult.error.code,
                details: ordersResult.error.details,
                hint: ordersResult.error.hint,
              }
            : null,
          audit: auditResult.error
            ? {
                message: auditResult.error.message,
                code: auditResult.error.code,
                details: auditResult.error.details,
                hint: auditResult.error.hint,
              }
            : null,
          // reliabilityResult.error est une string (normalisée dans listRepeatedRefusers), pas un PostgrestError.
          reliability: reliabilityResult.error ?? null,
        }),
      );
      return { ok: false as const, errorCode: 'data_error' as const };
    }

    const orders = ordersResult.data ?? [];
    const customerIds = [
      ...new Set(orders.map((order) => order.customer_id).filter(isNonEmptyString)),
    ];
    const orderIds = orders.map((order) => order.id);
    const driverIds = [
      ...new Set(orders.map((order) => order.assigned_driver_id).filter(isNonEmptyString)),
    ];

    const [orderLinesResult, customersResult, driversResult] = await Promise.all([
      orderIds.length > 0
        ? supabase
            .from('order_line')
            .select('order_id, product_id, raw_title, raw_sku, qty, match_status')
            .in('order_id', orderIds)
        : Promise.resolve({ data: [], error: null }),
      customerIds.length > 0
        ? supabase
            .from('customer')
            .select('id, full_name, address, shipping_address')
            .in('id', customerIds)
        : Promise.resolve({ data: [], error: null }),
      driverIds.length > 0
        ? supabase.from('driver').select('id, full_name').in('id', driverIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (orderLinesResult.error || customersResult.error || driversResult.error) {
      // DIAG (temporaire, branche diag/analyses-error-logging) : identifier QUELLE
      // requête du bloc 2 échoue. Ne change PAS la logique de retour.
      // biome-ignore lint/suspicious/noConsole: diagnostic temporaire (branche diag)
      console.error(
        '[loss-analytics] bloc 2 échec',
        JSON.stringify({
          merchantId,
          orderLines: orderLinesResult.error
            ? {
                message: orderLinesResult.error.message,
                code: orderLinesResult.error.code,
                details: orderLinesResult.error.details,
                hint: orderLinesResult.error.hint,
              }
            : null,
          customers: customersResult.error
            ? {
                message: customersResult.error.message,
                code: customersResult.error.code,
                details: customersResult.error.details,
                hint: customersResult.error.hint,
              }
            : null,
          drivers: driversResult.error
            ? {
                message: driversResult.error.message,
                code: driversResult.error.code,
                details: driversResult.error.details,
                hint: driversResult.error.hint,
              }
            : null,
        }),
      );
      return { ok: false as const, errorCode: 'data_error' as const };
    }

    let analytics: ReturnType<typeof computeLossAnalytics>;
    try {
      analytics = computeLossAnalytics({
        auditLogs: (auditResult.data ?? []).map((row) => ({
          createdAt: row.created_at,
          payload: row.payload,
          resourceId: row.resource_id,
        })),
        customers: (customersResult.data ?? []).map((row) => ({
          address: row.address,
          fullName: row.full_name,
          id: row.id,
          shippingAddress: row.shipping_address,
        })),
        drivers: (driversResult.data ?? []).map((row) => ({
          fullName: row.full_name,
          id: row.id,
        })),
        fromISO: from,
        orderLines: (orderLinesResult.data ?? []).map((row) => ({
          matchStatus: row.match_status,
          orderId: row.order_id,
          productId: row.product_id,
          qty: row.qty,
          rawSku: row.raw_sku,
          rawTitle: row.raw_title,
        })),
        orders: orders.map((row) => ({
          assignedDriverId: row.assigned_driver_id,
          cancelReason: row.cancel_reason,
          createdAt: row.created_at,
          customerId: row.customer_id,
          deliveryState: row.delivery_state,
          id: row.id,
          orderState: row.order_state,
          returnedAt: row.returned_at,
          source: row.source,
        })),
        reliability: reliabilityResult.data,
        toISO: to,
      });
    } catch (e) {
      // DIAG (temporaire, branche diag/analyses-error-logging) : capturer une exception
      // jetée par computeLossAnalytics AVEC la donnée fautive, puis re-jeter pour
      // qu'elle remonte à handleServerError/Sentry.
      // biome-ignore lint/suspicious/noConsole: diagnostic temporaire (branche diag)
      console.error(
        '[loss-analytics] computeLossAnalytics a jeté',
        JSON.stringify({
          merchantId,
          message: e instanceof Error ? e.message : String(e),
          stack: e instanceof Error ? e.stack : undefined,
        }),
      );
      throw e;
    }

    return { ok: true as const, analytics };
  });
