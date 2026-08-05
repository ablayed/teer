'use server';

import { requireRole } from '@/lib/actions/safe-action';
import {
  formatCustomerAddress,
  isRecurringCustomer,
  isRefuserCustomer,
} from '@/lib/customers/enrichment';
import type { ReliabilityTier } from '@/lib/customers/reliability';
import type { Database, Tables } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

type SupabaseServerClient = SupabaseClient<Database>;
type CustomerReliabilityRow =
  Database['public']['Functions']['list_customer_reliability']['Returns'][number];

export type CustomerListItem = {
  cancelledCount: number;
  customerId: string;
  decided: number;
  deliveredLifetime: number;
  fullName: string | null;
  isProvisional: boolean;
  // Récurrence dérivée (order_count Tëër > 1) — pas de colonne stockée. Forte valeur COD.
  isRecurring: boolean;
  isRefuser: boolean;
  orderCount: number;
  phone: string | null;
  refusedCount: number;
  score: number;
  tier: ReliabilityTier;
};

export type CustomerOrderHistoryItem = Pick<
  Tables<'orders'>,
  | 'cod_status'
  | 'created_at'
  | 'created_at_shopify'
  | 'currency'
  | 'id'
  | 'order_number'
  | 'total_amount'
>;

export type CustomerDetail = CustomerListItem & {
  actionsKey: 'new' | 'reliable' | 'risk' | 'watch';
  addressText: string | null;
  confirmScore: number | null;
  deliveryScore: number;
  flags: {
    cancelsOften: boolean;
    confirmsThenRefuses: boolean;
    hardToReach: boolean;
  };
  history: CustomerOrderHistoryItem[];
};

const listCustomersSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
  search: z.string().trim().max(120).optional(),
  sortByRisk: z.boolean().optional(),
});

const getCustomerSchema = z.object({
  customerId: z.string().uuid(),
});

function asTypedSupabaseClient(client: unknown): SupabaseServerClient {
  return client as SupabaseServerClient;
}

function toTier(value: string): ReliabilityTier {
  if (value === 'reliable' || value === 'risk' || value === 'watch') {
    return value;
  }

  return 'new';
}

function toListItem(row: CustomerReliabilityRow): CustomerListItem {
  return {
    cancelledCount: row.cancelled_count,
    customerId: row.customer_id,
    decided: row.decided,
    deliveredLifetime: row.delivered_lifetime,
    fullName: row.full_name ?? null,
    isProvisional: row.is_provisional,
    isRecurring: isRecurringCustomer(row.order_count),
    isRefuser: isRefuserCustomer(row.refused_count),
    orderCount: row.order_count,
    phone: row.phone ?? null,
    refusedCount: row.refused_count,
    score: row.score,
    tier: toTier(row.tier),
  };
}

export const listCustomersAction = requireRole('owner', 'manager', 'agent')
  .metadata({ actionName: 'customers.list', section: 'customers' })
  .inputSchema(listCustomersSchema)
  .action(async ({ ctx, parsedInput }) => {
    const supabase = asTypedSupabaseClient(ctx.supabase);
    const customersResult = await supabase.rpc('list_customer_reliability', {
      p_merchant_id: ctx.member.merchantAccountId,
      p_search: parsedInput.search || undefined,
      p_limit: parsedInput.limit ?? 50,
      p_offset: parsedInput.offset ?? 0,
      p_sort_by_risk: parsedInput.sortByRisk ?? false,
    });

    if (customersResult.error) {
      return { ok: false as const, errorCode: 'list_failed' as const };
    }

    return {
      ok: true as const,
      customers: (customersResult.data ?? []).map(toListItem),
      readOnly: ctx.member.role === 'agent',
    };
  });

export const getCustomerAction = requireRole('owner', 'manager', 'agent')
  .metadata({ actionName: 'customers.get', section: 'customers' })
  .inputSchema(getCustomerSchema)
  .action(async ({ ctx, parsedInput }) => {
    const supabase = asTypedSupabaseClient(ctx.supabase);
    const [customerResult, historyResult, enrichmentResult] = await Promise.all([
      supabase.rpc('get_customer_reliability', {
        p_merchant_id: ctx.member.merchantAccountId,
        p_customer_id: parsedInput.customerId,
      }),
      supabase
        .from('orders')
        .select(
          'id, order_number, total_amount, currency, cod_status, created_at_shopify, created_at',
        )
        .eq('merchant_account_id', ctx.member.merchantAccountId)
        .eq('customer_id', parsedInput.customerId)
        .order('created_at_shopify', { ascending: false, nullsFirst: false })
        .limit(30),
      // Colonnes PII enrichies (Phase 7b) absentes de la RPC de fiabilité.
      supabase
        .from('customer')
        .select('address, shipping_address')
        .eq('merchant_account_id', ctx.member.merchantAccountId)
        .eq('id', parsedInput.customerId)
        .maybeSingle(),
    ]);

    if (customerResult.error || historyResult.error || enrichmentResult.error) {
      return { ok: false as const, errorCode: 'get_failed' as const };
    }

    const row = customerResult.data?.[0];

    if (!row) {
      return { ok: false as const, errorCode: 'customer_not_found' as const };
    }

    const enrichment = enrichmentResult.data;
    const customer = toListItem(row);
    const detail: CustomerDetail = {
      ...customer,
      actionsKey: customer.tier,
      addressText: formatCustomerAddress(
        enrichment?.address ?? null,
        enrichment?.shipping_address ?? null,
      ),
      confirmScore: row.confirm_score,
      deliveryScore: row.delivery_score,
      flags: {
        cancelsOften: row.flag_cancels_often,
        confirmsThenRefuses: row.flag_confirms_then_refuses,
        hardToReach: row.flag_hard_to_reach,
      },
      history: (historyResult.data ?? []) as CustomerOrderHistoryItem[],
    };

    return {
      ok: true as const,
      customer: detail,
      readOnly: ctx.member.role === 'agent',
    };
  });
