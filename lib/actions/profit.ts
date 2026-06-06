'use server';

import { requireRole } from '@/lib/actions/safe-action';
import { orderStatuses } from '@/lib/domain/order-state-machine';
import { env } from '@/lib/env';
import {
  type ChartOrder,
  type FunnelPoint,
  type RevenuePoint,
  type ShopRevenuePoint,
  aggregateFunnel,
  aggregateShopRevenue,
  bucketRevenueByDay,
} from '@/lib/finance/charts';
import { type FeeSettings, computeFinanceReport } from '@/lib/finance/profit';
import type { Database } from '@/lib/supabase/database.types';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

const periodSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});

type AdminClient = ReturnType<typeof createAdmin>;

function createAdmin() {
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

type RawSoldRow = {
  order_id: string | null;
  product_id: string;
  qty: number;
  unit_cost: number | null;
};

type RawSettingsRow = {
  wave_fee_bps: number;
  orange_money_fee_bps: number;
  free_money_fee_bps: number;
  transfer_tax_bps: number;
  transfer_tax_cap_minor: number;
};

type RawExpenseRow = {
  amount_minor: number;
  category_id: string;
};

type RawReturnRow = {
  order_id: string | null;
  product_id: string;
  qty: number;
};

async function fetchSoldMovements(
  admin: AdminClient,
  merchantId: string,
  orderIds: string[],
): Promise<RawSoldRow[]> {
  if (orderIds.length === 0) return [];
  const { data, error } = await admin
    .from('stock_movement')
    .select('order_id, product_id, qty, unit_cost')
    .eq('merchant_account_id', merchantId)
    .eq('movement_type', 'sold')
    .in('order_id', orderIds);
  if (error) throw new Error('sold_fetch_error');
  return (data ?? []) as RawSoldRow[];
}

async function fetchCourierReturns(
  admin: AdminClient,
  merchantId: string,
  orderIds: string[],
): Promise<RawReturnRow[]> {
  if (orderIds.length === 0) return [];
  const { data, error } = await admin
    .from('stock_movement')
    .select('order_id, product_id, qty')
    .eq('merchant_account_id', merchantId)
    .eq('movement_type', 'courier_return')
    .in('order_id', orderIds);
  if (error) throw new Error('return_fetch_error');
  return (data ?? []) as RawReturnRow[];
}

export const getFinanceReportAction = requireRole('owner')
  .metadata({ actionName: 'profit.report', section: 'finance' })
  .inputSchema(periodSchema)
  .action(async ({ ctx, parsedInput }) => {
    const admin = createAdmin();
    const merchantId = ctx.member.merchantAccountId;
    const { from, to } = parsedInput;

    // 1. Commandes encaissées dans la période
    const { data: collectedRaw, error: e1 } = await admin
      .from('orders')
      .select('id, total_amount, payment_channel_at_delivery')
      .eq('merchant_account_id', merchantId)
      .gte('cash_collected_at', from)
      .lte('cash_collected_at', to);
    if (e1) return { ok: false as const, errorCode: 'data_error' as const };

    // 2. Retours dans la période (cash_collected_at non null = conta-revenue réel)
    const { data: returnedRaw, error: e2 } = await admin
      .from('orders')
      .select('id, total_amount')
      .eq('merchant_account_id', merchantId)
      .gte('returned_at', from)
      .lte('returned_at', to)
      .not('cash_collected_at', 'is', null);
    if (e2) return { ok: false as const, errorCode: 'data_error' as const };

    const collectedIds = (collectedRaw ?? []).map((o) => o.id);
    const returnedIds = (returnedRaw ?? []).map((o) => o.id);

    // 3. Mouvements sold + courier_return (unit_cost caché → admin requis)
    let soldForCollected: RawSoldRow[] = [];
    let soldForReturned: RawSoldRow[] = [];
    let courierReturnRows: RawReturnRow[] = [];
    try {
      [soldForCollected, soldForReturned, courierReturnRows] = await Promise.all([
        fetchSoldMovements(admin, merchantId, collectedIds),
        fetchSoldMovements(admin, merchantId, returnedIds),
        fetchCourierReturns(admin, merchantId, returnedIds),
      ]);
    } catch {
      return { ok: false as const, errorCode: 'data_error' as const };
    }

    // 4. Dépenses (admin pour éviter l'ambiguïté de type sur ctx.supabase)
    const fromDate = from.slice(0, 10);
    const toDate = to.slice(0, 10);
    const { data: expenseRaw, error: e4 } = await admin
      .from('expense')
      .select('amount_minor, category_id')
      .eq('merchant_account_id', merchantId)
      .gte('spent_at', fromDate)
      .lte('spent_at', toDate);
    if (e4) return { ok: false as const, errorCode: 'data_error' as const };
    const typedExpenseRaw = (expenseRaw ?? []) as RawExpenseRow[];

    // 5. Catégories pour les dépenses du mois
    const categoryIds = [...new Set(typedExpenseRaw.map((e) => e.category_id))];
    const categoryMap = new Map<string, { code: string; label_fr: string }>();
    if (categoryIds.length > 0) {
      const { data: catsRaw } = await admin
        .from('expense_category')
        .select('id, code, label_fr')
        .in('id', categoryIds);
      const cats = (catsRaw ?? []) as { id: string; code: string; label_fr: string }[];
      for (const c of cats) categoryMap.set(c.id, c);
    }

    // 6. Paramètres frais mobile money
    const { data: settingsRaw } = await admin
      .from('merchant_settings')
      .select('*')
      .eq('merchant_account_id', merchantId)
      .maybeSingle();
    const settingsRow = settingsRaw as RawSettingsRow | null;

    const settings: FeeSettings = {
      waveFee: settingsRow?.wave_fee_bps ?? 100,
      orangeMoneyFee: settingsRow?.orange_money_fee_bps ?? 100,
      freeMoneyFee: settingsRow?.free_money_fee_bps ?? 100,
      transferTaxBps: settingsRow?.transfer_tax_bps ?? 50,
      transferTaxCapMinor: settingsRow?.transfer_tax_cap_minor ?? 2_000,
    };

    // 7. Infos produit (titre + CUMP courant) — pour le tableau par produit ET le fallback
    // d'estimation du COGS (coût figé = 0 → CUMP courant). Couvre collected + returned.
    const allProductIds = [
      ...new Set([...soldForCollected, ...soldForReturned].map((m) => m.product_id)),
    ];
    const productInfo = new Map<string, { title: string; currentUnitCostMinor: number }>();
    if (allProductIds.length > 0) {
      const [productsRes, stockRes] = await Promise.all([
        admin.from('product').select('id, title').in('id', allProductIds),
        admin.from('product_stock').select('product_id, unit_cost').in('product_id', allProductIds),
      ]);
      const stockByCost = new Map((stockRes.data ?? []).map((s) => [s.product_id, s.unit_cost]));
      for (const p of productsRes.data ?? []) {
        productInfo.set(p.id, {
          title: p.title,
          currentUnitCostMinor: stockByCost.get(p.id) ?? 0,
        });
      }
    }

    const report = computeFinanceReport({
      collectedOrders: (collectedRaw ?? []).map((o) => ({
        id: o.id,
        totalAmount: o.total_amount,
        paymentChannelAtDelivery: o.payment_channel_at_delivery,
      })),
      soldMovementsForCollected: soldForCollected
        .filter(
          (m): m is RawSoldRow & { order_id: string; unit_cost: number } =>
            m.order_id !== null && m.unit_cost !== null,
        )
        .map((m) => ({
          orderId: m.order_id,
          productId: m.product_id,
          qty: m.qty,
          unitCost: m.unit_cost,
        })),
      returnedOrders: (returnedRaw ?? []).map((o) => ({
        id: o.id,
        totalAmount: o.total_amount,
      })),
      courierReturns: courierReturnRows
        .filter((m): m is RawReturnRow & { order_id: string } => m.order_id !== null)
        .map((m) => ({ orderId: m.order_id, productId: m.product_id, qty: m.qty })),
      soldMovementsForReturned: soldForReturned
        .filter(
          (m): m is RawSoldRow & { order_id: string; unit_cost: number } =>
            m.order_id !== null && m.unit_cost !== null,
        )
        .map((m) => ({
          orderId: m.order_id,
          productId: m.product_id,
          qty: m.qty,
          unitCost: m.unit_cost,
        })),
      expenses: typedExpenseRaw.map((e) => {
        const cat = categoryMap.get(e.category_id);
        return {
          categoryCode: cat?.code ?? 'OTHER',
          categoryLabel: cat?.label_fr ?? 'Autres',
          amountMinor: e.amount_minor,
        };
      }),
      settings,
      productInfo,
    });

    return { ok: true as const, report };
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
    const admin = createAdmin();
    const merchantId = ctx.member.merchantAccountId;
    const { from, to } = parsedInput;

    const [collectedRes, shopsRes, funnelRes] = await Promise.all([
      admin
        .from('orders')
        .select('total_amount, cash_collected_at, shop_id')
        .eq('merchant_account_id', merchantId)
        .gte('cash_collected_at', from)
        .lte('cash_collected_at', to),
      admin.from('shop').select('id, shop_domain').eq('merchant_account_id', merchantId),
      admin
        .from('orders')
        .select('cod_status')
        .eq('merchant_account_id', merchantId)
        .gte('created_at', from)
        .lte('created_at', to),
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
