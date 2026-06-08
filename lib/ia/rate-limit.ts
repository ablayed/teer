import type { IaToolContext } from '@/lib/ia/types';

// Rate-limit par utilisateur : nombre d'appels d'outils sur une fenêtre
// glissante, compté côté Postgres via la RPC SECURITY DEFINER
// ia_count_recent_tool_calls (l'utilisateur ne lit jamais ia_tool_audit).
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX_CALLS = 30;

export async function checkToolRateLimit(
  ctx: Pick<IaToolContext, 'supabase' | 'merchantAccountId'>,
): Promise<{ ok: boolean; count: number }> {
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
  const { data, error } = await ctx.supabase.rpc('ia_count_recent_tool_calls', {
    p_merchant_account_id: ctx.merchantAccountId,
    p_since: since,
  });

  // Fail-open : un incident de comptage ne doit pas bloquer la conversation.
  if (error) {
    return { ok: true, count: 0 };
  }

  const count = Number(data ?? 0);
  return { ok: count < RATE_LIMIT_MAX_CALLS, count };
}
