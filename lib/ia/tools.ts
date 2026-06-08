import { type OrderStatus, orderStatuses } from '@/lib/domain/order-state-machine';
import { logToolAudit } from '@/lib/ia/audit';
import { fetchLossSummary } from '@/lib/ia/loss-data';
import { channelSchema, periodSchema, resolvePeriod } from '@/lib/ia/periods';
import { type IaTool, type IaToolContext, type IaToolRunResult, defineTool } from '@/lib/ia/types';
import type { TeamRole } from '@/lib/team/permissions';
import { z } from 'zod';

// Statuts comptés comme « vendus / en cours de livraison » pour le top produits.
const SELLING_STATUSES: OrderStatus[] = ['CONFIRMEE', 'PROGRAMMEE', 'EN_LIVRAISON', 'LIVREE'];
const DELIVERED_STATUS = 'LIVREE';
const CANCELLED_STATUSES = new Set(['ANNULEE', 'REFUSEE']);

function toNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function parseItemsSummary(
  value: unknown,
): Array<{ title: string; quantity: number; price: number }> {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: Array<{ title: string; quantity: number; price: number }> = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    const record = raw as Record<string, unknown>;
    const title = typeof record.title === 'string' ? record.title : null;
    if (!title) {
      continue;
    }
    items.push({ title, quantity: toNumber(record.quantity), price: toNumber(record.price) });
  }
  return items;
}

// ───────────────────────────── Outils v1 (non-finance) ─────────────────────

// 1. Répartition des statuts COD sur une période — tous rôles.
const getOrderStatusSummary = defineTool({
  name: 'get_order_status_summary',
  description:
    'Répartition des commandes par statut COD (A_APPELER, TENTEE, CONFIRMEE, PROGRAMMEE, EN_LIVRAISON, LIVREE, REFUSEE, ANNULEE) créées sur une période.',
  allowedRoles: ['owner', 'manager', 'agent'],
  inputSchema: z.object({ period: periodSchema }),
  async execute(ctx, input) {
    const { from, to } = resolvePeriod(input.period);
    const { data, error } = await ctx.supabase
      .from('orders')
      .select('cod_status')
      .eq('merchant_account_id', ctx.merchantAccountId)
      .gte('created_at', from)
      .lte('created_at', to);
    if (error) {
      throw new Error('data_error');
    }
    const counts: Record<string, number> = Object.fromEntries(
      orderStatuses.map((status) => [status, 0]),
    );
    for (const row of data ?? []) {
      if (row.cod_status && row.cod_status in counts) {
        counts[row.cod_status] += 1;
      }
    }
    return { period: input.period, total: (data ?? []).length, byStatus: counts };
  },
});

// 2. Produits sous le seuil de stock bas — tous rôles (pas de coût/marge).
const getLowStock = defineTool({
  name: 'get_low_stock',
  description:
    'Liste des produits dont le stock disponible est au niveau ou sous le seuil de stock bas (quantités uniquement, aucun coût).',
  allowedRoles: ['owner', 'manager', 'agent'],
  inputSchema: z.object({}),
  async execute(ctx) {
    const { data, error } = await ctx.supabase
      .from('product_stock')
      .select(
        'product_id, qty_on_hand, qty_reserved, low_stock_threshold, product:product_id(title, sku)',
      )
      .eq('merchant_account_id', ctx.merchantAccountId);
    if (error) {
      throw new Error('data_error');
    }
    const low = (data ?? [])
      .filter((row) => toNumber(row.qty_on_hand) <= toNumber(row.low_stock_threshold))
      .map((row) => {
        const product = row.product as { title?: string | null; sku?: string | null } | null;
        return {
          productId: row.product_id,
          title: product?.title ?? null,
          sku: product?.sku ?? null,
          qtyOnHand: toNumber(row.qty_on_hand),
          qtyReserved: toNumber(row.qty_reserved),
          threshold: toNumber(row.low_stock_threshold),
        };
      })
      .sort((a, b) => a.qtyOnHand - b.qtyOnHand)
      .slice(0, 50);
    return { count: low.length, products: low };
  },
});

// 3. Top produits par unités sur une période — tous rôles.
// Le CA n'est exposé QU'AUX rôles owner/manager (agent : unités seulement).
const getTopProducts = defineTool({
  name: 'get_top_products',
  description:
    "Produits les plus commandés sur une période, classés par unités (commandes confirmées à livrées). Le chiffre d'affaires n'est disponible que pour owner/manager.",
  allowedRoles: ['owner', 'manager', 'agent'],
  inputSchema: z.object({
    period: periodSchema,
    limit: z.number().int().min(1).max(20).optional(),
  }),
  async execute(ctx, input) {
    const { from, to } = resolvePeriod(input.period);
    const limit = input.limit ?? 5;
    const { data, error } = await ctx.supabase
      .from('orders')
      .select('items_summary')
      .eq('merchant_account_id', ctx.merchantAccountId)
      .in('cod_status', SELLING_STATUSES)
      .gte('created_at', from)
      .lte('created_at', to);
    if (error) {
      throw new Error('data_error');
    }
    const byTitle = new Map<string, { units: number; revenue: number }>();
    for (const order of data ?? []) {
      for (const item of parseItemsSummary(order.items_summary)) {
        const current = byTitle.get(item.title) ?? { units: 0, revenue: 0 };
        current.units += item.quantity;
        current.revenue += item.quantity * item.price;
        byTitle.set(item.title, current);
      }
    }
    const showRevenue = ctx.role !== 'agent';
    const products = [...byTitle.entries()]
      .map(([name, agg]) => ({
        name,
        units: agg.units,
        ...(showRevenue ? { revenue: agg.revenue } : {}),
      }))
      .sort((a, b) => b.units - a.units)
      .slice(0, limit);
    return { period: input.period, products };
  },
});

// 4. Fiabilité d'un client (récurrence / refus / tier) — tous rôles.
const getCustomerReliability = defineTool({
  name: 'get_customer_reliability',
  description:
    "Score de fiabilité d'un client : récurrence (order_count), refus (refused_count), tier et drapeaux de risque. Aucun montant.",
  allowedRoles: ['owner', 'manager', 'agent'],
  inputSchema: z.object({ customer_id: z.string().uuid() }),
  async execute(ctx, input) {
    const { data, error } = await ctx.supabase.rpc('get_customer_reliability', {
      p_customer_id: input.customer_id,
      p_merchant_id: ctx.merchantAccountId,
    });
    if (error) {
      throw new Error('data_error');
    }
    const row = Array.isArray(data) ? data[0] : null;
    if (!row) {
      return { found: false };
    }
    return {
      found: true,
      customerId: row.customer_id,
      fullName: row.full_name,
      tier: row.tier,
      score: row.score,
      orderCount: row.order_count,
      refusedCount: row.refused_count,
      cancelledCount: row.cancelled_count,
      deliveredCount: row.delivered_count,
      isProvisional: row.is_provisional,
      flags: {
        hardToReach: row.flag_hard_to_reach,
        cancelsOften: row.flag_cancels_often,
        confirmsThenRefuses: row.flag_confirms_then_refuses,
      },
    };
  },
});

// 5. Taux de RTO (échecs de livraison) — owner + manager.
const getRtoRate = defineTool({
  name: 'get_rto_rate',
  description:
    "Taux de RTO (return-to-origin = livraisons échouées, delivery_state=failed) sur une période, éventuellement filtré par canal. RTO = échec, distinct d'un retour après livraison.",
  allowedRoles: ['owner', 'manager'],
  inputSchema: z.object({ period: periodSchema, channel: channelSchema.optional() }),
  async execute(ctx, input) {
    const { from, to } = resolvePeriod(input.period);
    const loss = await fetchLossSummary(ctx, from, to);
    if (!loss.ok) {
      throw new Error('data_error');
    }
    if (input.channel) {
      const scorecard = loss.result.sourceScorecard.find((s) => s.source === input.channel);
      return {
        period: input.period,
        channel: input.channel,
        rtoRate: scorecard?.rtoRate ?? 0,
        rtoCount: scorecard?.rtoCount ?? 0,
        deliveredCount: scorecard?.deliveredCount ?? 0,
        totalOrders: scorecard?.totalOrders ?? 0,
      };
    }
    const { rtoRate, rtoCount, deliveredCount, rtoDenominator } = loss.result.summary;
    return { period: input.period, rtoRate, rtoCount, deliveredCount, denominator: rtoDenominator };
  },
});

// 6. Taux d'annulation — owner + manager.
const getCancellationRate = defineTool({
  name: 'get_cancellation_rate',
  description:
    "Taux d'annulation (commandes annulées avant livraison) sur une période, rapporté au total des commandes.",
  allowedRoles: ['owner', 'manager'],
  inputSchema: z.object({ period: periodSchema }),
  async execute(ctx, input) {
    const { from, to } = resolvePeriod(input.period);
    const loss = await fetchLossSummary(ctx, from, to);
    if (!loss.ok) {
      throw new Error('data_error');
    }
    const { cancellationRate, cancellationCount, totalOrders } = loss.result.summary;
    return { period: input.period, cancellationRate, cancellationCount, totalOrders };
  },
});

// 7. Performance par livreur (succès / livrées / annulées) — owner + manager.
// Aucun montant (le cash par livreur relève de la finance, hors v1 non-finance).
const getDriverPerformance = defineTool({
  name: 'get_driver_performance',
  description:
    'Performance opérationnelle par livreur sur une période : livraisons réussies, annulées/refusées et taux de succès. Aucun montant de cash.',
  allowedRoles: ['owner', 'manager'],
  inputSchema: z.object({ period: periodSchema, driver_id: z.string().uuid().optional() }),
  async execute(ctx, input) {
    const { from, to } = resolvePeriod(input.period);
    let query = ctx.supabase
      .from('orders')
      .select('assigned_driver_id, cod_status')
      .eq('merchant_account_id', ctx.merchantAccountId)
      .not('assigned_driver_id', 'is', null)
      .gte('created_at', from)
      .lte('created_at', to);
    if (input.driver_id) {
      query = query.eq('assigned_driver_id', input.driver_id);
    }
    const [ordersResult, driversResult] = await Promise.all([
      query,
      ctx.supabase
        .from('driver')
        .select('id, full_name')
        .eq('merchant_account_id', ctx.merchantAccountId),
    ]);
    if (ordersResult.error || driversResult.error) {
      throw new Error('data_error');
    }
    const nameById = new Map((driversResult.data ?? []).map((d) => [d.id, d.full_name]));
    const agg = new Map<string, { delivered: number; cancelled: number }>();
    for (const order of ordersResult.data ?? []) {
      const driverId = order.assigned_driver_id;
      if (!driverId) {
        continue;
      }
      const current = agg.get(driverId) ?? { delivered: 0, cancelled: 0 };
      if (order.cod_status === DELIVERED_STATUS) {
        current.delivered += 1;
      } else if (order.cod_status && CANCELLED_STATUSES.has(order.cod_status)) {
        current.cancelled += 1;
      }
      agg.set(driverId, current);
    }
    const drivers = [...agg.entries()]
      .map(([driverId, { delivered, cancelled }]) => {
        const decided = delivered + cancelled;
        return {
          driverId,
          driverName: nameById.get(driverId) ?? null,
          deliveredCount: delivered,
          cancelledCount: cancelled,
          successRate: decided > 0 ? delivered / decided : 0,
        };
      })
      .sort((a, b) => b.deliveredCount - a.deliveredCount);
    return { period: input.period, drivers };
  },
});

// ───────────────────────────── Catalogue + exécution ───────────────────────

// Catalogue FIXE. Source unique de vérité ; le LLM ne voit que ce qui est ici.
export const IA_TOOL_CATALOG: IaTool[] = [
  getOrderStatusSummary,
  getLowStock,
  getTopProducts,
  getCustomerReliability,
  getRtoRate,
  getCancellationRate,
  getDriverPerformance,
];

// Couche A : sous-ensemble du catalogue autorisé pour un rôle.
export function getToolsForRole(role: TeamRole): IaTool[] {
  return IA_TOOL_CATALOG.filter((tool) => tool.allowedRoles.includes(role));
}

// Couche B : re-vérification du rôle + validation des args + audit, à CHAQUE
// appel — qu'il soit légitime, halluciné ou forcé par injection.
export async function runTool(
  ctx: IaToolContext,
  toolName: string,
  rawArgs: unknown,
): Promise<IaToolRunResult> {
  const startedAt = Date.now();
  const tool = IA_TOOL_CATALOG.find((t) => t.name === toolName);

  if (!tool) {
    await logToolAudit(ctx, {
      toolName,
      toolArgs: rawArgs,
      allowed: false,
      deniedReason: 'unknown_tool',
    });
    return { ok: false, error: 'unknown_tool' };
  }

  // Couche B — autorisation. Un agent appelant get_margin/get_rto_rate échoue
  // ici même si le LLM l'a forcé : pas de données renvoyées.
  if (!tool.allowedRoles.includes(ctx.role)) {
    await logToolAudit(ctx, {
      toolName,
      toolArgs: rawArgs,
      allowed: false,
      deniedReason: 'forbidden_role',
      latencyMs: Date.now() - startedAt,
    });
    return { ok: false, error: 'forbidden_role' };
  }

  const parsed = tool.inputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    await logToolAudit(ctx, {
      toolName,
      toolArgs: rawArgs,
      allowed: false,
      deniedReason: 'invalid_args',
      latencyMs: Date.now() - startedAt,
    });
    return { ok: false, error: 'invalid_args' };
  }

  try {
    const data = await tool.execute(ctx, parsed.data);
    await logToolAudit(ctx, {
      toolName,
      toolArgs: parsed.data,
      allowed: true,
      latencyMs: Date.now() - startedAt,
    });
    return { ok: true, data };
  } catch (error) {
    // Appel autorisé mais en erreur d'exécution : on journalise (allowed=true)
    // avec la cause, sans interrompre la conversation.
    await logToolAudit(ctx, {
      toolName,
      toolArgs: parsed.data,
      allowed: true,
      deniedReason: `execution_error: ${error instanceof Error ? error.message : 'unknown'}`,
      latencyMs: Date.now() - startedAt,
    });
    return { ok: false, error: 'execution_error' };
  }
}
