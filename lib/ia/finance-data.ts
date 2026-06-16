import { type FeeSettings, type FinanceReport, computeFinanceReport } from '@/lib/finance/profit';
import type { IaToolContext } from '@/lib/ia/types';

// Construit le P&L (CA, COGS, marge, profit net) SOUS LE JWT (RLS) — jamais
// service-role. Les seules colonnes hors-grant (unit_cost) sont obtenues via
// les RPC SECURITY DEFINER role-gardées ia_finance_cost_movements /
// ia_product_cump. Tout le reste (commandes, charges, paramètres, titres) est
// lu sous RLS, et le calcul réutilise la fonction PURE computeFinanceReport.
// Renvoie null en cas d'erreur de données.
export async function fetchFinanceReportRls(
  ctx: Pick<IaToolContext, 'supabase' | 'merchantAccountId'>,
  fromIso: string,
  toIso: string,
): Promise<FinanceReport | null> {
  const { supabase, merchantAccountId: merchantId } = ctx;

  // 1. Commandes encaissées dans la période.
  const { data: collectedRaw, error: e1 } = await supabase
    .from('orders')
    .select('id, total_amount, delivery_fee_minor, payment_channel_at_delivery')
    .eq('merchant_account_id', merchantId)
    .gte('cash_collected_at', fromIso)
    .lte('cash_collected_at', toIso);
  if (e1) {
    return null;
  }

  // 2. Retours encaissés dans la période (contra-revenue réel).
  const { data: returnedRaw, error: e2 } = await supabase
    .from('orders')
    .select('id, total_amount, delivery_fee_minor')
    .eq('merchant_account_id', merchantId)
    .gte('returned_at', fromIso)
    .lte('returned_at', toIso)
    .not('cash_collected_at', 'is', null);
  if (e2) {
    return null;
  }

  const collected = collectedRaw ?? [];
  const returned = returnedRaw ?? [];
  const collectedIds = new Set(collected.map((o) => o.id));
  const returnedIds = new Set(returned.map((o) => o.id));
  const allOrderIds = [...new Set([...collectedIds, ...returnedIds])];

  // 3. Mouvements porteurs de coût (RPC role-gardée owner/manager → unit_cost).
  let costRows: {
    order_id: string | null;
    product_id: string;
    qty: number;
    unit_cost: number | null;
    movement_type: string;
  }[] = [];
  if (allOrderIds.length > 0) {
    const { data, error } = await supabase.rpc('ia_finance_cost_movements', {
      p_merchant: merchantId,
      p_order_ids: allOrderIds,
    });
    if (error) {
      return null;
    }
    costRows = data ?? [];
  }

  const soldForCollected = costRows.filter(
    (r) => r.movement_type === 'sold' && r.order_id !== null && collectedIds.has(r.order_id),
  );
  const soldForReturned = costRows.filter(
    (r) => r.movement_type === 'sold' && r.order_id !== null && returnedIds.has(r.order_id),
  );
  const courierReturns = costRows.filter(
    (r) => r.movement_type === 'courier_return' && r.order_id !== null,
  );

  // 4. Charges (RLS owner-only : un manager obtient 0 ligne — sans effet sur le COGS).
  const fromDate = fromIso.slice(0, 10);
  const toDate = toIso.slice(0, 10);
  const { data: expenseRaw } = await supabase
    .from('expense')
    .select('amount_minor, category_id')
    .eq('merchant_account_id', merchantId)
    .gte('spent_at', fromDate)
    .lte('spent_at', toDate);
  const expenses = expenseRaw ?? [];

  // 5. Catégories des charges de la période.
  const categoryIds = [...new Set(expenses.map((e) => e.category_id))];
  const categoryMap = new Map<string, { code: string; label_fr: string }>();
  if (categoryIds.length > 0) {
    const { data: catsRaw } = await supabase
      .from('expense_category')
      .select('id, code, label_fr')
      .in('id', categoryIds);
    for (const c of catsRaw ?? []) {
      categoryMap.set(c.id, { code: c.code, label_fr: c.label_fr });
    }
  }

  // 6. Paramètres frais mobile money (défauts si absent / non lisible).
  const { data: settingsRaw } = await supabase
    .from('merchant_settings')
    .select(
      'wave_fee_bps, orange_money_fee_bps, free_money_fee_bps, transfer_tax_bps, transfer_tax_cap_minor',
    )
    .eq('merchant_account_id', merchantId)
    .maybeSingle();
  const settings: FeeSettings = {
    waveFee: settingsRaw?.wave_fee_bps ?? 100,
    orangeMoneyFee: settingsRaw?.orange_money_fee_bps ?? 100,
    freeMoneyFee: settingsRaw?.free_money_fee_bps ?? 100,
    transferTaxBps: settingsRaw?.transfer_tax_bps ?? 50,
    transferTaxCapMinor: settingsRaw?.transfer_tax_cap_minor ?? 2_000,
  };

  // 7. Titres produits (RLS) + CUMP courant (RPC role-gardée) pour le fallback.
  const allProductIds = [
    ...new Set([...soldForCollected, ...soldForReturned].map((m) => m.product_id)),
  ];
  const productInfo = new Map<string, { title: string; currentUnitCostMinor: number }>();
  if (allProductIds.length > 0) {
    const [productsRes, cumpRes] = await Promise.all([
      supabase.from('product').select('id, title').in('id', allProductIds),
      supabase.rpc('ia_product_cump', { p_merchant: merchantId, p_product_ids: allProductIds }),
    ]);
    const cumpByProduct = new Map((cumpRes.data ?? []).map((r) => [r.product_id, r.unit_cost]));
    for (const p of productsRes.data ?? []) {
      productInfo.set(p.id, {
        title: p.title,
        currentUnitCostMinor: cumpByProduct.get(p.id) ?? 0,
      });
    }
  }

  return computeFinanceReport({
    collectedOrders: collected.map((o) => ({
      id: o.id,
      deliveryFeeMinor: o.delivery_fee_minor,
      totalAmount: o.total_amount,
      paymentChannelAtDelivery: o.payment_channel_at_delivery,
    })),
    soldMovementsForCollected: soldForCollected
      .filter((m): m is typeof m & { order_id: string; unit_cost: number } => m.unit_cost !== null)
      .map((m) => ({
        orderId: m.order_id as string,
        productId: m.product_id,
        qty: m.qty,
        unitCost: m.unit_cost as number,
      })),
    returnedOrders: returned.map((o) => ({
      id: o.id,
      deliveryFeeMinor: o.delivery_fee_minor,
      totalAmount: o.total_amount,
    })),
    courierReturns: courierReturns.map((m) => ({
      orderId: m.order_id as string,
      productId: m.product_id,
      qty: m.qty,
    })),
    soldMovementsForReturned: soldForReturned
      .filter((m): m is typeof m & { order_id: string; unit_cost: number } => m.unit_cost !== null)
      .map((m) => ({
        orderId: m.order_id as string,
        productId: m.product_id,
        qty: m.qty,
        unitCost: m.unit_cost as number,
      })),
    expenses: expenses.map((e) => {
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
