import type { IaToolContext } from '@/lib/ia/types';
import { type LossAnalyticsResult, computeLossAnalytics } from '@/lib/loss-analytics/metrics';

// Calcule le résumé des pertes (RTO / annulation / retour) sous RLS.
// Réutilise la fonction PURE computeLossAnalytics ; n'a besoin que de `orders`
// + `audit_log` pour le résumé et le scorecard par canal (les autres entrées
// — lignes, clients, livreurs, fiabilité — restent vides ici).
export async function fetchLossSummary(
  ctx: IaToolContext,
  from: string,
  to: string,
): Promise<{ ok: true; result: LossAnalyticsResult } | { ok: false; error: string }> {
  const [ordersResult, auditResult] = await Promise.all([
    ctx.supabase
      .from('orders')
      .select('id, source, delivery_state, order_state, created_at, returned_at')
      .eq('merchant_account_id', ctx.merchantAccountId)
      .gte('created_at', from)
      .lte('created_at', to),
    ctx.supabase
      .from('audit_log')
      .select('resource_id, payload, created_at')
      .eq('merchant_account_id', ctx.merchantAccountId)
      .eq('action', 'order.transition')
      .eq('resource_type', 'orders')
      .gte('created_at', from)
      .lte('created_at', to),
  ]);

  if (ordersResult.error || auditResult.error) {
    return { ok: false, error: 'data_error' };
  }

  const result = computeLossAnalytics({
    auditLogs: (auditResult.data ?? []).map((row) => ({
      createdAt: row.created_at,
      payload: row.payload,
      resourceId: row.resource_id,
    })),
    customers: [],
    drivers: [],
    fromISO: from,
    orderLines: [],
    orders: (ordersResult.data ?? []).map((row) => ({
      assignedDriverId: null,
      cancelReason: null,
      createdAt: row.created_at,
      customerId: null,
      deliveryState: row.delivery_state,
      id: row.id,
      orderState: row.order_state,
      returnedAt: row.returned_at,
      source: row.source,
    })),
    reliability: [],
    toISO: to,
  });

  return { ok: true, result };
}
