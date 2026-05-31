'use server';

import { authActionClient } from '@/lib/actions/safe-action';
import type { Database, Json } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';

type SupabaseServerClient = SupabaseClient<Database>;
type DashboardKpiRpcRow = Database['public']['Functions']['get_dashboard_kpi']['Returns'][number];

export type DashboardSparklinePoint = {
  date: string;
  caCollecte: number;
};

export type DashboardKpi = {
  aAppelerCount: number;
  aAppelerDelta: number;
  caCollecte7j: number;
  caEnAttente: number;
  tauxConfirmation: number;
  tauxLivraison: number;
  sparkline7j: DashboardSparklinePoint[];
};

export type DashboardKpiActionResult =
  | { ok: true; data: DashboardKpi }
  | { ok: false; errorCode: 'not_found' | 'rpc_error' };

function asTypedSupabaseClient(client: unknown): SupabaseServerClient {
  return client as SupabaseServerClient;
}

function isJsonRecord(value: Json): value is { [key: string]: Json | undefined } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSparkline(value: Json): DashboardSparklinePoint[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!isJsonRecord(item)) {
        return null;
      }

      const date = item.date;
      const caCollecte = item.ca_collecte;

      if (typeof date !== 'string' || typeof caCollecte !== 'number') {
        return null;
      }

      return {
        date,
        caCollecte,
      };
    })
    .filter((item): item is DashboardSparklinePoint => item !== null);
}

function toDashboardKpi(row: DashboardKpiRpcRow): DashboardKpi {
  return {
    aAppelerCount: row.a_appeler_count,
    aAppelerDelta: row.a_appeler_delta,
    caCollecte7j: row.ca_collecte_7j,
    caEnAttente: row.ca_en_attente,
    tauxConfirmation: row.taux_confirmation,
    tauxLivraison: row.taux_livraison,
    sparkline7j: parseSparkline(row.sparkline_7j),
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

  const { data, error } = await supabase.rpc('get_dashboard_kpi', {
    p_merchant_id: member.merchant_account_id,
  });

  if (error) {
    return { ok: false, errorCode: 'rpc_error' };
  }

  const row = data.at(0);

  if (!row) {
    return { ok: false, errorCode: 'not_found' };
  }

  return { ok: true, data: toDashboardKpi(row) };
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
