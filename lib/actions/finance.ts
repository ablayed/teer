'use server';

import { requireRole } from '@/lib/actions/safe-action';
import {
  type SettlementMethod,
  cashCollectableMinor,
  paymentChannelsAtDelivery,
  settlementMethods,
} from '@/lib/finance/cash';
import type { Database, Json, Tables } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

type SupabaseServerClient = SupabaseClient<Database>;
type FinanceKpiRow = Database['public']['Functions']['finance_kpis']['Returns'][number];
type CashAgingRow = Database['public']['Functions']['cash_aging']['Returns'][number];
type OrderFinanceRow = Pick<
  Tables<'orders'>,
  | 'assigned_driver_id'
  | 'cash_collectable_minor'
  | 'created_at'
  | 'currency'
  | 'id'
  | 'order_number'
  | 'payment_channel_at_delivery'
  | 'total_amount'
  | 'updated_at'
>;
type DriverRow = Pick<Tables<'driver'>, 'full_name' | 'id' | 'phone'>;
type AllocationRow = Pick<Tables<'settlement_allocation'>, 'allocated_minor' | 'order_id'>;

export type DriverOutstandingOrder = {
  currency: string;
  orderId: string;
  orderNumber: string | null;
  outstandingMinor: number;
  totalMinor: number;
};

export type DriverOutstanding = {
  driverId: string;
  driverName: string;
  driverPhone: string;
  orders: DriverOutstandingOrder[];
  outstandingMinor: number;
};

const safeMinor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const allocationSchema = z.object({
  orderId: z.string().uuid(),
  allocatedMinor: safeMinor.min(1),
});

const recordSettlementSchema = z.object({
  allocations: z.array(allocationSchema).optional(),
  amountReceivedMinor: safeMinor,
  clientRequestId: z.string().uuid(),
  driverId: z.string().uuid(),
  method: z.enum(settlementMethods),
  note: z.string().trim().max(500).optional(),
});

const writeOffShortfallSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  shortfallId: z.string().uuid(),
});

const listDriverOutstandingSchema = z.object({
  driverId: z.string().uuid().optional(),
});

const financeKpisSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});

function asTypedSupabaseClient(client: unknown): SupabaseServerClient {
  return client as SupabaseServerClient;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function settlementPayload(value: unknown): {
  allocatedMinor: number;
  expectedMinor: number | null;
  idempotent: boolean;
  settlementId: string;
  shortfallId: string | null;
  shortfallMinor: number | null;
} | null {
  if (!isRecord(value) || typeof value.settlementId !== 'string') {
    return null;
  }

  return {
    allocatedMinor: typeof value.allocatedMinor === 'number' ? value.allocatedMinor : 0,
    expectedMinor: typeof value.expectedMinor === 'number' ? value.expectedMinor : null,
    idempotent: value.idempotent === true,
    settlementId: value.settlementId,
    shortfallId: typeof value.shortfallId === 'string' ? value.shortfallId : null,
    shortfallMinor: typeof value.shortfallMinor === 'number' ? value.shortfallMinor : null,
  };
}

function writeOffPayload(value: unknown): {
  allocatedMinor: number;
  remainingMinor: number;
  shortfallId: string;
  writeOffSettlementId: string;
} | null {
  if (
    !isRecord(value) ||
    typeof value.shortfallId !== 'string' ||
    typeof value.writeOffSettlementId !== 'string'
  ) {
    return null;
  }

  return {
    allocatedMinor: typeof value.allocatedMinor === 'number' ? value.allocatedMinor : 0,
    remainingMinor: typeof value.remainingMinor === 'number' ? value.remainingMinor : 0,
    shortfallId: value.shortfallId,
    writeOffSettlementId: value.writeOffSettlementId,
  };
}

function recordSettlementRpc(supabase: SupabaseServerClient) {
  return supabase.rpc as unknown as (
    fn: 'record_cash_settlement',
    args: {
      p_actor: string;
      p_allocations?: Json;
      p_amount_received_minor: number;
      p_client_request_id: string;
      p_driver: string;
      p_merchant: string;
      p_method: SettlementMethod;
      p_note?: string | null;
    },
  ) => ReturnType<SupabaseServerClient['rpc']>;
}

function writeOffShortfallRpc(supabase: SupabaseServerClient) {
  return supabase.rpc as unknown as (
    fn: 'write_off_shortfall',
    args: {
      p_actor: string;
      p_merchant: string;
      p_reason: string;
      p_shortfall_id: string;
    },
  ) => ReturnType<SupabaseServerClient['rpc']>;
}

function paymentChannelIsCash(channel: string | null): boolean {
  return channel === null || channel === 'ESPECES' || channel === 'INCONNU';
}

export const recordSettlementAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'finance.record_settlement', section: 'finance' })
  .inputSchema(recordSettlementSchema)
  .action(async ({ ctx, parsedInput }) => {
    const supabase = asTypedSupabaseClient(ctx.supabase);
    const { data, error } = await recordSettlementRpc(supabase)('record_cash_settlement', {
      p_actor: ctx.user.id,
      p_allocations: (parsedInput.allocations ?? []) as Json,
      p_amount_received_minor: parsedInput.amountReceivedMinor,
      p_client_request_id: parsedInput.clientRequestId,
      p_driver: parsedInput.driverId,
      p_merchant: ctx.member.merchantAccountId,
      p_method: parsedInput.method,
      p_note: parsedInput.note ?? null,
    });

    if (error) {
      return { ok: false as const, errorCode: 'settlement_failed' as const };
    }

    const payload = settlementPayload(data);

    if (!payload) {
      return { ok: false as const, errorCode: 'settlement_failed' as const };
    }

    return { ok: true as const, ...payload };
  });

export const writeOffShortfallAction = requireRole('owner')
  .metadata({ actionName: 'finance.write_off_shortfall', section: 'finance' })
  .inputSchema(writeOffShortfallSchema)
  .action(async ({ ctx, parsedInput }) => {
    const supabase = asTypedSupabaseClient(ctx.supabase);
    const { data, error } = await writeOffShortfallRpc(supabase)('write_off_shortfall', {
      p_actor: ctx.user.id,
      p_merchant: ctx.member.merchantAccountId,
      p_reason: parsedInput.reason,
      p_shortfall_id: parsedInput.shortfallId,
    });

    if (error) {
      return { ok: false as const, errorCode: 'write_off_failed' as const };
    }

    const payload = writeOffPayload(data);

    if (!payload) {
      return { ok: false as const, errorCode: 'write_off_failed' as const };
    }

    return { ok: true as const, ...payload };
  });

export const listDriverOutstandingAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'finance.list_driver_outstanding', section: 'finance' })
  .inputSchema(listDriverOutstandingSchema)
  .action(async ({ ctx, parsedInput }) => {
    const supabase = asTypedSupabaseClient(ctx.supabase);
    let ordersQuery = supabase
      .from('orders')
      .select(
        'id, order_number, total_amount, currency, cash_collectable_minor, payment_channel_at_delivery, assigned_driver_id, created_at, updated_at',
      )
      .eq('merchant_account_id', ctx.member.merchantAccountId)
      .eq('cod_status', 'LIVREE')
      .not('assigned_driver_id', 'is', null);

    if (parsedInput.driverId) {
      ordersQuery = ordersQuery.eq('assigned_driver_id', parsedInput.driverId);
    }

    const [ordersResult, driversResult] = await Promise.all([
      ordersQuery,
      supabase
        .from('driver')
        .select('id, full_name, phone')
        .eq('merchant_account_id', ctx.member.merchantAccountId),
    ]);

    if (ordersResult.error || driversResult.error) {
      return { ok: false as const, errorCode: 'list_failed' as const };
    }

    const orders = ((ordersResult.data ?? []) as OrderFinanceRow[]).filter((order) =>
      paymentChannelIsCash(order.payment_channel_at_delivery),
    );
    const orderIds = orders.map((order) => order.id);
    const allocationsResult =
      orderIds.length > 0
        ? await supabase
            .from('settlement_allocation')
            .select('order_id, allocated_minor')
            .eq('merchant_account_id', ctx.member.merchantAccountId)
            .in('order_id', orderIds)
        : { data: [], error: null };

    if (allocationsResult.error) {
      return { ok: false as const, errorCode: 'list_failed' as const };
    }

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
    const byDriver = new Map<string, DriverOutstanding>();

    for (const order of orders) {
      if (!order.assigned_driver_id) {
        continue;
      }

      const totalMinor = cashCollectableMinor({
        cashCollectableMinor: order.cash_collectable_minor,
        paymentChannel: order.payment_channel_at_delivery,
        totalAmount: order.total_amount,
      });
      const outstandingMinor = Math.max(totalMinor - (allocatedByOrder.get(order.id) ?? 0), 0);

      if (outstandingMinor <= 0) {
        continue;
      }

      const driver = driversById.get(order.assigned_driver_id);
      const current = byDriver.get(order.assigned_driver_id) ?? {
        driverId: order.assigned_driver_id,
        driverName: driver?.full_name ?? 'Livreur',
        driverPhone: driver?.phone ?? '',
        orders: [],
        outstandingMinor: 0,
      };

      current.orders.push({
        currency: order.currency,
        orderId: order.id,
        orderNumber: order.order_number,
        outstandingMinor,
        totalMinor,
      });
      current.outstandingMinor += outstandingMinor;
      byDriver.set(order.assigned_driver_id, current);
    }

    return {
      ok: true as const,
      drivers: [...byDriver.values()].sort(
        (left, right) => right.outstandingMinor - left.outstandingMinor,
      ),
    };
  });

export const getFinanceKpisAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'finance.kpis', section: 'finance' })
  .inputSchema(financeKpisSchema)
  .action(async ({ ctx, parsedInput }) => {
    const supabase = asTypedSupabaseClient(ctx.supabase);
    const { data, error } = await supabase.rpc('finance_kpis', {
      p_merchant: ctx.member.merchantAccountId,
      p_from: parsedInput.from,
      p_to: parsedInput.to,
    });

    if (error) {
      return { ok: false as const, errorCode: 'kpis_failed' as const };
    }

    return { ok: true as const, kpis: (data?.[0] ?? null) as FinanceKpiRow | null };
  });

export const getCashAgingAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'finance.cash_aging', section: 'finance' })
  .inputSchema(z.object({}))
  .action(async ({ ctx }) => {
    const supabase = asTypedSupabaseClient(ctx.supabase);
    const { data, error } = await supabase.rpc('cash_aging', {
      p_merchant: ctx.member.merchantAccountId,
    });

    if (error) {
      return { ok: false as const, errorCode: 'aging_failed' as const };
    }

    return { ok: true as const, aging: (data ?? []) as CashAgingRow[] };
  });
