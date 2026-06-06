// Pure P&L computation functions for Phase 6.
// All amounts in XOF minor units (bigint-safe integers). No DB access.

export type CollectedOrder = {
  id: string;
  totalAmount: number;
  paymentChannelAtDelivery: string | null;
};

export type ReturnedOrder = {
  id: string;
  totalAmount: number;
};

export type SoldMovement = {
  orderId: string;
  productId: string;
  qty: number; // positive
  unitCost: number; // CUMP snapshotted at delivery
};

export type CourierReturnMovement = {
  orderId: string;
  productId: string;
  qty: number; // positive
};

export type ExpenseRow = {
  categoryCode: string;
  categoryLabel: string;
  amountMinor: number;
};

export type FeeSettings = {
  waveFee: number; // bps
  orangeMoneyFee: number; // bps
  freeMoneyFee: number; // bps
  transferTaxBps: number; // bps
  transferTaxCapMinor: number;
};

export type CategoryTotal = {
  code: string;
  label: string;
  totalMinor: number;
};

export type ProductBreakdown = {
  productId: string;
  title: string;
  qtySold: number;
  cogsMinor: number;
  currentUnitCostMinor: number;
};

export type FinanceReport = {
  caMinor: number;
  returnContraRevenueMinor: number;
  netCAMinor: number;
  cogsMinor: number;
  returnedCogsReversalMinor: number;
  netCogsMinor: number;
  grossMarginMinor: number;
  grossMarginBps: number; // ×10 000 / netCA; 0 if CA=0
  mobileMoneyFeesMinor: number;
  expensesMinor: number;
  expensesByCategory: CategoryTotal[];
  netProfitMinor: number;
  productBreakdown: ProductBreakdown[];
};

function roundBps(amountMinor: number, bps: number): number {
  return Number((BigInt(amountMinor) * BigInt(bps) + 5_000n) / 10_000n);
}

function orderMMFee(totalAmount: number, channel: string | null, s: FeeSettings): number {
  let feeBps: number;
  if (channel === 'WAVE') feeBps = s.waveFee;
  else if (channel === 'ORANGE_MONEY') feeBps = s.orangeMoneyFee;
  else if (channel === 'FREE_MONEY') feeBps = s.freeMoneyFee;
  else return 0;

  const providerFee = roundBps(totalAmount, feeBps);
  const transferTax = Math.min(roundBps(totalAmount, s.transferTaxBps), s.transferTaxCapMinor);
  return providerFee + transferTax;
}

export function computeCA(orders: Pick<CollectedOrder, 'totalAmount'>[]): number {
  return orders.reduce((sum, o) => sum + o.totalAmount, 0);
}

export function computeReturnContraRevenue(returns: Pick<ReturnedOrder, 'totalAmount'>[]): number {
  return returns.reduce((sum, o) => sum + o.totalAmount, 0);
}

export function computeCOGS(soldMovements: SoldMovement[]): number {
  return soldMovements.reduce((sum, m) => sum + m.unitCost * m.qty, 0);
}

// COGS reversal for restocked returns: find frozen unit_cost from the original sold movement.
// soldByOrderProduct: `${orderId}:${productId}` → unitCost at delivery.
export function computeReturnedCogsReversal(
  courierReturns: CourierReturnMovement[],
  soldByOrderProduct: Map<string, number>,
): number {
  return courierReturns.reduce((sum, cr) => {
    const unitCost = soldByOrderProduct.get(`${cr.orderId}:${cr.productId}`) ?? 0;
    return sum + unitCost * cr.qty;
  }, 0);
}

export function computeMobileMoneyFees(
  orders: Pick<CollectedOrder, 'totalAmount' | 'paymentChannelAtDelivery'>[],
  settings: FeeSettings,
): number {
  return orders.reduce(
    (sum, o) => sum + orderMMFee(o.totalAmount, o.paymentChannelAtDelivery, settings),
    0,
  );
}

export function computeExpensesByCategory(expenses: ExpenseRow[]): CategoryTotal[] {
  const byCode = new Map<string, CategoryTotal>();
  for (const e of expenses) {
    const existing = byCode.get(e.categoryCode);
    if (existing) {
      existing.totalMinor += e.amountMinor;
    } else {
      byCode.set(e.categoryCode, {
        code: e.categoryCode,
        label: e.categoryLabel,
        totalMinor: e.amountMinor,
      });
    }
  }
  return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
}

export function computeProductBreakdown(
  soldMovements: SoldMovement[],
  productInfo: Map<string, { title: string; currentUnitCostMinor: number }>,
): ProductBreakdown[] {
  const byProduct = new Map<string, { qtySold: number; cogsMinor: number }>();
  for (const m of soldMovements) {
    const existing = byProduct.get(m.productId);
    if (existing) {
      existing.qtySold += m.qty;
      existing.cogsMinor += m.unitCost * m.qty;
    } else {
      byProduct.set(m.productId, { qtySold: m.qty, cogsMinor: m.unitCost * m.qty });
    }
  }
  return [...byProduct.entries()]
    .map(([productId, stats]) => ({
      productId,
      title: productInfo.get(productId)?.title ?? productId,
      qtySold: stats.qtySold,
      cogsMinor: stats.cogsMinor,
      currentUnitCostMinor: productInfo.get(productId)?.currentUnitCostMinor ?? 0,
    }))
    .sort((a, b) => b.cogsMinor - a.cogsMinor);
}

export function computeFinanceReport({
  collectedOrders,
  soldMovementsForCollected,
  returnedOrders,
  courierReturns,
  soldMovementsForReturned,
  expenses,
  settings,
  productInfo,
}: {
  collectedOrders: CollectedOrder[];
  soldMovementsForCollected: SoldMovement[];
  returnedOrders: ReturnedOrder[];
  courierReturns: CourierReturnMovement[];
  // sold movements for returned orders — needed to look up frozen unit_cost for reversal
  soldMovementsForReturned: SoldMovement[];
  expenses: ExpenseRow[];
  settings: FeeSettings;
  productInfo: Map<string, { title: string; currentUnitCostMinor: number }>;
}): FinanceReport {
  const caMinor = computeCA(collectedOrders);
  const returnContraRevenueMinor = computeReturnContraRevenue(returnedOrders);
  const netCAMinor = caMinor - returnContraRevenueMinor;

  const cogsMinor = computeCOGS(soldMovementsForCollected);

  // Build unit_cost lookup from both sets (Case 1: collected+returned same period is in both)
  const soldByOrderProduct = new Map<string, number>();
  for (const m of [...soldMovementsForCollected, ...soldMovementsForReturned]) {
    const key = `${m.orderId}:${m.productId}`;
    if (!soldByOrderProduct.has(key)) soldByOrderProduct.set(key, m.unitCost);
  }

  const returnedCogsReversalMinor = computeReturnedCogsReversal(courierReturns, soldByOrderProduct);
  const netCogsMinor = cogsMinor - returnedCogsReversalMinor;

  const grossMarginMinor = netCAMinor - netCogsMinor;
  const grossMarginBps = netCAMinor > 0 ? Math.round((grossMarginMinor * 10_000) / netCAMinor) : 0;

  const mobileMoneyFeesMinor = computeMobileMoneyFees(collectedOrders, settings);
  const expensesByCategory = computeExpensesByCategory(expenses);
  const expensesMinor = expenses.reduce((sum, e) => sum + e.amountMinor, 0);
  const netProfitMinor = grossMarginMinor - expensesMinor - mobileMoneyFeesMinor;

  const productBreakdown = computeProductBreakdown(soldMovementsForCollected, productInfo);

  return {
    caMinor,
    returnContraRevenueMinor,
    netCAMinor,
    cogsMinor,
    returnedCogsReversalMinor,
    netCogsMinor,
    grossMarginMinor,
    grossMarginBps,
    mobileMoneyFeesMinor,
    expensesMinor,
    expensesByCategory,
    netProfitMinor,
    productBreakdown,
  };
}
