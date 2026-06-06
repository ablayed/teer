// Shared finance P&L data builder (Phase 6c) — used by the owner-only finance report action
// AND the PDF report route. Reads stock_movement.unit_cost (hidden from non-owner at the column
// level) → MUST run through the service-role admin client. No 'use server' here so non-action
// helpers can be exported and reused.

import { env } from '@/lib/env';
import { type FeeSettings, type FinanceReport, computeFinanceReport } from '@/lib/finance/profit';
import type { Database } from '@/lib/supabase/database.types';
import { createClient } from '@supabase/supabase-js';

export type FinanceAdminClient = ReturnType<typeof createFinanceAdminClient>;

export function createFinanceAdminClient() {
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
  admin: FinanceAdminClient,
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
  admin: FinanceAdminClient,
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

// Calcule le compte de résultat (P&L) returns-aware sur la période [fromIso, toIso].
// CA = commandes avec cash_collected_at dans la période ; COGS = sold.unit_cost figé (fallback
// CUMP, lignes au coût inconnu exclues) ; retours, frais mobile money, charges, résultat net.
export async function fetchFinanceReport(
  admin: FinanceAdminClient,
  merchantId: string,
  fromIso: string,
  toIso: string,
): Promise<FinanceReport> {
  // 1. Commandes encaissées dans la période
  const { data: collectedRaw, error: e1 } = await admin
    .from('orders')
    .select('id, total_amount, payment_channel_at_delivery')
    .eq('merchant_account_id', merchantId)
    .gte('cash_collected_at', fromIso)
    .lte('cash_collected_at', toIso);
  if (e1) throw new Error('finance_data_error');

  // 2. Retours dans la période (cash_collected_at non null = contra-revenue réel)
  const { data: returnedRaw, error: e2 } = await admin
    .from('orders')
    .select('id, total_amount')
    .eq('merchant_account_id', merchantId)
    .gte('returned_at', fromIso)
    .lte('returned_at', toIso)
    .not('cash_collected_at', 'is', null);
  if (e2) throw new Error('finance_data_error');

  const collectedIds = (collectedRaw ?? []).map((o) => o.id);
  const returnedIds = (returnedRaw ?? []).map((o) => o.id);

  // 3. Mouvements sold + courier_return (unit_cost caché → admin requis)
  const [soldForCollected, soldForReturned, courierReturnRows] = await Promise.all([
    fetchSoldMovements(admin, merchantId, collectedIds),
    fetchSoldMovements(admin, merchantId, returnedIds),
    fetchCourierReturns(admin, merchantId, returnedIds),
  ]);

  // 4. Dépenses
  const fromDate = fromIso.slice(0, 10);
  const toDate = toIso.slice(0, 10);
  const { data: expenseRaw, error: e4 } = await admin
    .from('expense')
    .select('amount_minor, category_id')
    .eq('merchant_account_id', merchantId)
    .gte('spent_at', fromDate)
    .lte('spent_at', toDate);
  if (e4) throw new Error('finance_data_error');
  const typedExpenseRaw = (expenseRaw ?? []) as RawExpenseRow[];

  // 5. Catégories pour les dépenses de la période
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

  // 7. Infos produit (titre + CUMP courant) — tableau par produit ET fallback d'estimation.
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

  return computeFinanceReport({
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
    returnedOrders: (returnedRaw ?? []).map((o) => ({ id: o.id, totalAmount: o.total_amount })),
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
}
