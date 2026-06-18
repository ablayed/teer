'use server';

import { requireRole } from '@/lib/actions/safe-action';
import { orderStatuses } from '@/lib/domain/order-state-machine';
import {
  type ChartOrder,
  type FunnelPoint,
  type RevenuePoint,
  type ShopRevenuePoint,
  aggregateFunnel,
  aggregateShopRevenue,
  bucketRevenueByDay,
} from '@/lib/finance/charts';
import { createFinanceAdminClient, fetchFinanceReport } from '@/lib/finance/report-data';
import { z } from 'zod';

const periodSchema = z.object({
  from: z.string().datetime(),
  shopId: z.string().uuid().nullable().optional(),
  to: z.string().datetime(),
});

export const getFinanceReportAction = requireRole('owner')
  .metadata({ actionName: 'profit.report', section: 'finance' })
  .inputSchema(periodSchema)
  .action(async ({ ctx, parsedInput }) => {
    const admin = createFinanceAdminClient();
    const { from, shopId, to } = parsedInput;
    try {
      const report = await fetchFinanceReport(
        admin,
        ctx.member.merchantAccountId,
        from,
        to,
        shopId ?? null,
      );
      return { ok: true as const, report };
    } catch {
      return { ok: false as const, errorCode: 'data_error' as const };
    }
  });

export type FinanceCharts = {
  revenue: RevenuePoint[];
  shops: ShopRevenuePoint[];
  funnel: FunnelPoint[];
};

// Graphes finance période-aware (owner-only). Contrairement aux actions dashboard
// (fenêtre fixe 30 j / all-time, partagées avec /tableau), tout réagit ici au sélecteur :
//   - revenue : CA encaissé par jour (cash_collected_at dans la période) ;
//   - shops   : CA encaissé par boutique sur la période ;
//   - funnel  : entonnoir COD des commandes créées dans la période.
export const getFinanceChartsAction = requireRole('owner')
  .metadata({ actionName: 'profit.charts', section: 'finance' })
  .inputSchema(periodSchema)
  .action(async ({ ctx, parsedInput }) => {
    const admin = createFinanceAdminClient();
    const merchantId = ctx.member.merchantAccountId;
    const { from, shopId, to } = parsedInput;

    let collectedQuery = admin
      .from('orders')
      .select('total_amount, cash_collected_at, shop_id')
      .eq('merchant_account_id', merchantId)
      .gte('cash_collected_at', from)
      .lte('cash_collected_at', to);
    let shopsQuery = admin
      .from('shop')
      .select('id, shop_domain')
      .eq('merchant_account_id', merchantId);
    let funnelQuery = admin
      .from('orders')
      .select('cod_status')
      .eq('merchant_account_id', merchantId)
      .gte('created_at', from)
      .lte('created_at', to);

    if (shopId) {
      collectedQuery = collectedQuery.eq('shop_id', shopId);
      shopsQuery = shopsQuery.eq('id', shopId);
      funnelQuery = funnelQuery.eq('shop_id', shopId);
    }

    const [collectedRes, shopsRes, funnelRes] = await Promise.all([
      collectedQuery,
      shopsQuery,
      funnelQuery,
    ]);

    if (collectedRes.error || shopsRes.error || funnelRes.error) {
      return { ok: false as const, errorCode: 'data_error' as const };
    }

    const collected: ChartOrder[] = (collectedRes.data ?? []).map((o) => ({
      totalAmount: o.total_amount,
      cashCollectedAt: o.cash_collected_at,
      shopId: o.shop_id,
    }));
    const shopNameById = new Map(
      (shopsRes.data ?? []).map((s) => [s.id, s.shop_domain] as [string, string]),
    );
    const codStatuses = (funnelRes.data ?? [])
      .map((o) => o.cod_status)
      .filter((s): s is string => s !== null);

    const charts: FinanceCharts = {
      revenue: bucketRevenueByDay(collected, from, to),
      shops: aggregateShopRevenue(collected, shopNameById),
      funnel: aggregateFunnel(codStatuses, orderStatuses),
    };

    return { ok: true as const, charts };
  });
