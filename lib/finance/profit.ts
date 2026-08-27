// Pure P&L computation functions for Phase 6.
// All amounts in XOF minor units (bigint-safe integers). No DB access.

export type CollectedOrder = {
  id: string;
  deliveryFeeMinor?: number;
  totalAmount: number;
  paymentChannelAtDelivery: string | null;
};

export type ReturnedOrder = {
  id: string;
  deliveryFeeMinor?: number;
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
  estimated: boolean; // au moins une ligne au CUMP courant (coût figé manquant)
};

export type FinanceReport = {
  caMinor: number;
  deliveryFeesMinor: number;
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
  // Qualité du COGS — coût de revient figé (sold.unit_cost) vs fallback CUMP courant.
  cogsEstimated: boolean; // ≥1 ligne estimée au CUMP courant (coût figé = 0) → marge « estimée »
  cogsEstimatedMinor: number; // part du COGS issue du fallback CUMP
  cogsCostedOrderCount: number; // commandes encaissées avec ≥1 ligne à coût connu (figé ou estimé)
  cogsExcludedOrderCount: number; // commandes encaissées sans aucune ligne à coût connu → exclues
  cogsUnknownLineCount: number; // lignes sold au coût totalement inconnu (figé ET CUMP = 0) → exclues, signalées
};

// Mouvement sold avec son coût de revient résolu.
// fallback = coût estimé au CUMP courant (figé manquant) ; unknown = aucun coût connu (figé ET CUMP = 0).
type CostedMovement = SoldMovement & { fallback: boolean; unknown: boolean };

// Coût de revient effectif d'une ligne : le coût figé prime quand il existe (> 0) ;
// sinon fallback sur le CUMP courant du produit (estimation) ; sinon coût totalement inconnu
// (`unknown`) → la ligne sera EXCLUE du COGS et signalée, jamais comptée 0 silencieusement.
function effectiveUnitCost(
  frozen: number,
  currentCump: number,
): { unit: number; fallback: boolean; unknown: boolean } {
  if (frozen > 0) return { unit: frozen, fallback: false, unknown: false };
  if (currentCump > 0) return { unit: currentCump, fallback: true, unknown: false };
  return { unit: 0, fallback: false, unknown: true };
}

// Résout le coût de chaque mouvement sold : coût figé si > 0, sinon CUMP courant du produit
// (marqué `fallback` = estimation), sinon `unknown`. Le coût figé réel reste toujours prioritaire.
export function applyEffectiveCost(
  movements: SoldMovement[],
  productInfo: Map<string, { title: string; currentUnitCostMinor: number }>,
): CostedMovement[] {
  return movements.map((m) => {
    const cump = productInfo.get(m.productId)?.currentUnitCostMinor ?? 0;
    const { unit, fallback, unknown } = effectiveUnitCost(m.unitCost, cump);
    return { ...m, unitCost: unit, fallback, unknown };
  });
}

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

export function computeDeliveryFees(orders: Pick<CollectedOrder, 'deliveryFeeMinor'>[]): number {
  return orders.reduce((sum, o) => sum + (o.deliveryFeeMinor ?? 0), 0);
}

export function computeReturnContraRevenue(
  returns: Pick<ReturnedOrder, 'totalAmount' | 'deliveryFeeMinor'>[],
): number {
  return returns.reduce((sum, o) => sum + o.totalAmount - (o.deliveryFeeMinor ?? 0), 0);
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

// Attend des mouvements déjà costés (cf. applyEffectiveCost) : `unitCost` = coût effectif,
// `fallback` = true si ce coût vient du CUMP courant (estimation) et non du coût figé.
export function computeProductBreakdown(
  soldMovements: CostedMovement[],
  productInfo: Map<string, { title: string; currentUnitCostMinor: number }>,
): ProductBreakdown[] {
  const byProduct = new Map<string, { qtySold: number; cogsMinor: number; estimated: boolean }>();
  for (const m of soldMovements) {
    const existing = byProduct.get(m.productId);
    if (existing) {
      existing.qtySold += m.qty;
      existing.cogsMinor += m.unitCost * m.qty;
      existing.estimated = existing.estimated || m.fallback;
    } else {
      byProduct.set(m.productId, {
        qtySold: m.qty,
        cogsMinor: m.unitCost * m.qty,
        estimated: m.fallback,
      });
    }
  }
  return [...byProduct.entries()]
    .map(([productId, stats]) => ({
      productId,
      title: productInfo.get(productId)?.title ?? productId,
      qtySold: stats.qtySold,
      cogsMinor: stats.cogsMinor,
      currentUnitCostMinor: productInfo.get(productId)?.currentUnitCostMinor ?? 0,
      estimated: stats.estimated,
    }))
    .sort((a, b) => b.cogsMinor - a.cogsMinor);
}

// Lot A1 (Phase F) : règle d'affichage binaire — dès qu'au moins une commande ou une ligne
// est exclue du calcul du COGS, la marge/le résultat net sont des chiffres FAUX (dénominateur
// amputé), jamais de simples approximations. Un seuil de couverture est une décision de
// conception qui relève de F2 ; cette fonction ne fait que signaler l'exclusion, jamais un taux.
export function isProfitCoverageIncomplete(
  report: Pick<FinanceReport, 'cogsExcludedOrderCount' | 'cogsUnknownLineCount'>,
): boolean {
  return report.cogsExcludedOrderCount > 0 || report.cogsUnknownLineCount > 0;
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
  const deliveryFeesMinor = computeDeliveryFees(collectedOrders);
  const returnContraRevenueMinor = computeReturnContraRevenue(returnedOrders);
  const netCAMinor = caMinor - deliveryFeesMinor - returnContraRevenueMinor;

  // Résout le coût de chaque ligne : coût figé prioritaire, sinon fallback CUMP courant (estimé),
  // sinon `unknown` (coût totalement inconnu) → exclu du COGS.
  const costedCollected = applyEffectiveCost(soldMovementsForCollected, productInfo);
  const costedReturned = applyEffectiveCost(soldMovementsForReturned, productInfo);

  // Seules les lignes à coût connu (figé ou estimé) entrent dans le COGS. Les lignes `unknown`
  // sont exclues et signalées (cogsUnknownLineCount) — jamais comptées 0 silencieusement.
  const knownCollected = costedCollected.filter((m) => !m.unknown);
  const knownReturned = costedReturned.filter((m) => !m.unknown);

  const cogsMinor = computeCOGS(knownCollected);
  const cogsEstimatedMinor = knownCollected
    .filter((m) => m.fallback)
    .reduce((sum, m) => sum + m.unitCost * m.qty, 0);
  const cogsEstimated = cogsEstimatedMinor > 0;
  const cogsUnknownLineCount = costedCollected.filter((m) => m.unknown).length;

  // Commandes encaissées avec ≥1 ligne à coût connu → COGS calculable ; sans aucune (pas de ligne
  // OU toutes les lignes au coût inconnu) → exclues, même traitement.
  const costedOrderIds = new Set(knownCollected.map((m) => m.orderId));
  const cogsCostedOrderCount = costedOrderIds.size;
  const cogsExcludedOrderCount = collectedOrders.filter((o) => !costedOrderIds.has(o.id)).length;

  // Build unit_cost lookup from both sets (Case 1: collected+returned same period is in both),
  // coût effectif connu (figé prioritaire, sinon CUMP) pour rester cohérent avec le COGS.
  const soldByOrderProduct = new Map<string, number>();
  for (const m of [...knownCollected, ...knownReturned]) {
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

  const productBreakdown = computeProductBreakdown(knownCollected, productInfo);

  return {
    caMinor,
    deliveryFeesMinor,
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
    cogsEstimated,
    cogsEstimatedMinor,
    cogsCostedOrderCount,
    cogsExcludedOrderCount,
    cogsUnknownLineCount,
  };
}
