'use server';

import { authActionClient } from '@/lib/actions/safe-action';
import type { Database } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';

type SupabaseServerClient = SupabaseClient<Database>;
type GeneratedDashboardKpiRpcRow =
  Database['public']['Functions']['get_dashboard_kpi']['Returns'][number];

type DashboardKpiRpcPayload = {
  [Key in keyof GeneratedDashboardKpiRpcRow]?: unknown;
};

export type DashboardSparklinePoint = {
  date: string;
  value: number;
};

export type DashboardKpi = {
  a_appeler_count: number;
  a_appeler_delta: number;
  ca_collecte_7j: number;
  ca_en_attente: number;
  currency: string | null;
  taux_confirmation: number;
  taux_livraison: number;
  sparkline_7j: DashboardSparklinePoint[];
};

export type DashboardKpiActionResult =
  | { ok: true; data: DashboardKpi }
  | { ok: false; errorCode: 'not_found' | 'rpc_error' };

export type DashboardRevenuePoint = {
  date: string;
  value: number;
};

export type DashboardRevenue30d = {
  currency: string | null;
  points: DashboardRevenuePoint[];
};

export type DashboardRevenue30dActionResult =
  | { ok: true; data: DashboardRevenue30d }
  | { ok: false; errorCode: 'not_found' | 'query_error' };

function asTypedSupabaseClient(client: unknown): SupabaseServerClient {
  return client as SupabaseServerClient;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberFromRpc(value: unknown): number {
  const numericValue = Number(value ?? 0);

  return Number.isFinite(numericValue) ? numericValue : 0;
}

function parseJsonString(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return [];
  }
}

function parseSparkline(value: unknown): DashboardSparklinePoint[] {
  const parsedValue = typeof value === 'string' ? parseJsonString(value) : value;
  const rawItems = Array.isArray(parsedValue)
    ? parsedValue
    : isRecord(parsedValue)
      ? Object.values(parsedValue)
      : [];

  return rawItems
    .map((item) => {
      if (!isRecord(item)) {
        return null;
      }

      const date = item.date;
      const sparklineValue = numberFromRpc(item.value);

      if (typeof date !== 'string') {
        return null;
      }

      return {
        date,
        value: sparklineValue,
      };
    })
    .filter((item): item is DashboardSparklinePoint => item !== null);
}

function firstRpcRow(value: unknown): DashboardKpiRpcPayload | null {
  const row = Array.isArray(value) ? value[0] : value;

  return isRecord(row) ? row : null;
}

function normalizeCurrency(value: string | null | undefined): string | null {
  const currency = value?.trim().toUpperCase();

  return currency ? currency : null;
}

function toDashboardKpi(row: DashboardKpiRpcPayload, currency: string | null): DashboardKpi {
  return {
    a_appeler_count: numberFromRpc(row.a_appeler_count),
    a_appeler_delta: numberFromRpc(row.a_appeler_delta),
    ca_collecte_7j: numberFromRpc(row.ca_collecte_7j),
    ca_en_attente: numberFromRpc(row.ca_en_attente),
    currency,
    taux_confirmation: numberFromRpc(row.taux_confirmation),
    taux_livraison: numberFromRpc(row.taux_livraison),
    sparkline_7j: parseSparkline(row.sparkline_7j),
  };
}

async function getMerchantAccountIdForUser({
  supabase,
  userId,
}: {
  supabase: SupabaseServerClient;
  userId: string;
}): Promise<{ ok: true; merchantAccountId: string } | { ok: false }> {
  const { data: member, error } = await supabase
    .from('merchant_member')
    .select('merchant_account_id')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();

  if (error || !member) {
    return { ok: false };
  }

  return { ok: true, merchantAccountId: member.merchant_account_id };
}

function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function createEmptyRevenueWindow(today = new Date()): DashboardRevenuePoint[] {
  return Array.from({ length: 30 }, (_, index) => {
    const date = new Date(today);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - (29 - index));

    return { date: dateKey(date), value: 0 };
  });
}

function dateFromOrder(value: string | null, fallback: string): Date {
  return new Date(value ?? fallback);
}

function aggregateRevenue30d(
  orders: Array<{
    created_at: string;
    created_at_shopify: string | null;
    currency: string | null;
    total_amount: number;
  }>,
): DashboardRevenue30d {
  const points = createEmptyRevenueWindow();
  const pointIndex = new Map(points.map((point, index) => [point.date, index]));
  const firstPointDate = new Date(`${points[0]?.date ?? dateKey(new Date())}T00:00:00.000Z`);
  let currency: string | null = null;

  for (const order of orders) {
    const orderDate = dateFromOrder(order.created_at_shopify, order.created_at);

    if (orderDate < firstPointDate) {
      continue;
    }

    const index = pointIndex.get(dateKey(orderDate));

    if (index === undefined) {
      continue;
    }

    points[index].value += Number(order.total_amount ?? 0);
    currency ??= normalizeCurrency(order.currency);
  }

  return { currency, points };
}

async function fetchRevenue30dForUser({
  supabase,
  userId,
}: {
  supabase: SupabaseServerClient;
  userId: string;
}): Promise<DashboardRevenue30dActionResult> {
  const merchant = await getMerchantAccountIdForUser({ supabase, userId });

  if (!merchant.ok) {
    return { ok: false, errorCode: 'not_found' };
  }

  const { data, error } = await supabase
    .from('orders')
    .select('created_at, created_at_shopify, currency, total_amount')
    .eq('merchant_account_id', merchant.merchantAccountId)
    .eq('cod_status', 'LIVREE')
    .order('created_at', { ascending: false })
    .limit(5000);

  if (error) {
    return { ok: false, errorCode: 'query_error' };
  }

  return { ok: true, data: aggregateRevenue30d(data ?? []) };
}

async function fetchDashboardKpiForUser({
  supabase,
  userId,
}: {
  supabase: SupabaseServerClient;
  userId: string;
}): Promise<DashboardKpiActionResult> {
  const { data: member, error: memberError } = await supabase
    .from('merchant_member')
    .select('merchant_account_id')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();

  if (memberError) {
    return { ok: false, errorCode: 'rpc_error' };
  }

  if (!member) {
    return { ok: false, errorCode: 'not_found' };
  }

  const [kpiResult, currencyResult] = await Promise.all([
    supabase.rpc('get_dashboard_kpi', {
      p_merchant_id: member.merchant_account_id,
    }),
    supabase
      .from('orders')
      .select('currency')
      .eq('merchant_account_id', member.merchant_account_id)
      .not('currency', 'is', null)
      .limit(1)
      .maybeSingle(),
  ]);

  const { data, error } = kpiResult;

  if (error) {
    return { ok: false, errorCode: 'rpc_error' };
  }

  const row = firstRpcRow(data);

  if (!row) {
    return { ok: false, errorCode: 'not_found' };
  }

  return {
    ok: true,
    data: toDashboardKpi(
      row,
      currencyResult.error ? null : normalizeCurrency(currencyResult.data?.currency),
    ),
  };
}

export async function getDashboardKpi(): Promise<DashboardKpiActionResult> {
  const supabase = asTypedSupabaseClient(await createSupabaseServerClient());
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, errorCode: 'not_found' };
  }

  return fetchDashboardKpiForUser({ supabase, userId: user.id });
}

export const getDashboardKpiAction = authActionClient
  .metadata({ actionName: 'dashboard.get_kpi', section: 'dashboard' })
  .action(async ({ ctx }): Promise<DashboardKpiActionResult> => {
    return fetchDashboardKpiForUser({
      supabase: asTypedSupabaseClient(ctx.supabase),
      userId: ctx.user.id,
    });
  });

export async function getRevenue30d(): Promise<DashboardRevenue30dActionResult> {
  const supabase = asTypedSupabaseClient(await createSupabaseServerClient());
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, errorCode: 'not_found' };
  }

  return fetchRevenue30dForUser({ supabase, userId: user.id });
}

export const getRevenue30dAction = authActionClient
  .metadata({ actionName: 'dashboard.get_revenue_30d', section: 'dashboard' })
  .action(async ({ ctx }): Promise<DashboardRevenue30dActionResult> => {
    return fetchRevenue30dForUser({
      supabase: asTypedSupabaseClient(ctx.supabase),
      userId: ctx.user.id,
    });
  });
