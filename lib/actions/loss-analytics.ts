'use server';

import { requireRole } from '@/lib/actions/safe-action';
import { type LossAnalyticsReliability, computeLossAnalytics } from '@/lib/loss-analytics/metrics';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

type SupabaseServerClient = SupabaseClient<Database>;
type CustomerReliabilityRow =
  Database['public']['Functions']['list_customer_reliability']['Returns'][number];

const periodSchema = z.object({
  from: z.string().datetime(),
  shopId: z.string().uuid().nullable().optional(),
  to: z.string().datetime(),
});

function asTypedSupabaseClient(client: unknown): SupabaseServerClient {
  return client as SupabaseServerClient;
}

function toReliability(row: CustomerReliabilityRow): LossAnalyticsReliability {
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

async function listAllCustomerReliability(
  supabase: SupabaseServerClient,
  merchantId: string,
): Promise<{ data: LossAnalyticsReliability[]; error: string | null }> {
  const rows: LossAnalyticsReliability[] = [];
  let offset = 0;

  while (true) {
    const result = await supabase.rpc('list_customer_reliability', {
      p_limit: 100,
      p_merchant_id: merchantId,
      p_offset: offset,
      p_sort_by_risk: true,
    });

    if (result.error) {
      return { data: [], error: result.error.message };
    }

    const batch = (result.data ?? []).map(toReliability);
    rows.push(...batch);

    if (batch.length < 100) {
      break;
    }

    offset += batch.length;
  }

  return { data: rows, error: null };
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
      listAllCustomerReliability(supabase, merchantId),
    ]);

    if (ordersResult.error || auditResult.error || reliabilityResult.error) {
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
      return { ok: false as const, errorCode: 'data_error' as const };
    }

    const analytics = computeLossAnalytics({
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

    return { ok: true as const, analytics };
  });
