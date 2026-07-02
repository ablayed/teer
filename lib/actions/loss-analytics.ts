'use server';

import { requireRole } from '@/lib/actions/safe-action';
import { type LossAnalyticsReliability, computeLossAnalytics } from '@/lib/loss-analytics/metrics';
import type { Database, Json } from '@/lib/supabase/database.types';
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

// Forme du payload renvoyé par la RPC get_loss_analytics_joins (0078). Les clés d'objet
// sont les colonnes DB consommées telles quelles par le .map() ci-dessous ; les 3 ensembles
// sont TOUJOURS des tableaux ([] si vide, jamais null). Contrat exact : cf. migration 0078.
type LossAnalyticsJoinsPayload = {
  orderLines: Array<{
    order_id: string;
    product_id: string | null;
    raw_title: string;
    raw_sku: string | null;
    qty: number;
    match_status: string;
  }>;
  customers: Array<{
    id: string;
    full_name: string | null;
    address: Json | null;
    shipping_address: Json | null;
  }>;
  drivers: Array<{
    id: string;
    full_name: string;
  }>;
};

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
      return { ok: false as const, errorCode: 'data_error' as const };
    }

    const orders = ordersResult.data ?? [];

    // Fix Bug 2 : les gros .in() (order_line ~1000 UUID, customer ~800 UUID) débordaient
    // l'URL PostgREST → 400. La RPC 0078 part de la fenêtre marchand+dates (POST body,
    // aucun tableau d'UUID dans l'URL) et joint order_line/customer/driver côté SQL.
    // shopId null/undefined → param omis → default null côté SQL (pas de filtre boutique).
    const joinsResult = await supabase.rpc('get_loss_analytics_joins', {
      p_from: from,
      p_merchant_id: merchantId,
      p_shop_id: shopId ?? undefined,
      p_to: to,
    });

    if (joinsResult.error) {
      return { ok: false as const, errorCode: 'data_error' as const };
    }

    // Payload garanti par la RPC 0078 (3 clés toujours en tableaux, colonnes fixes =
    // celles consommées ci-dessous). Cast localisé (données maîtrisées, notre propre RPC)
    // converti immédiatement vers les types internes de computeLossAnalytics (inchangé).
    const joins = joinsResult.data as unknown as LossAnalyticsJoinsPayload;

    // Une exception éventuelle de computeLossAnalytics remonte à handleServerError (Sentry).
    const analytics = computeLossAnalytics({
      auditLogs: (auditResult.data ?? []).map((row) => ({
        createdAt: row.created_at,
        payload: row.payload,
        resourceId: row.resource_id,
      })),
      customers: joins.customers.map((row) => ({
        address: row.address,
        fullName: row.full_name,
        id: row.id,
        shippingAddress: row.shipping_address,
      })),
      drivers: joins.drivers.map((row) => ({
        fullName: row.full_name,
        id: row.id,
      })),
      fromISO: from,
      orderLines: joins.orderLines.map((row) => ({
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

    return { ok: true as const, analytics };
  });
