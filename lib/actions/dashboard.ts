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
