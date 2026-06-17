import type { FinanceAdminClient } from '@/lib/finance/report-data';
import type { Json } from '@/lib/supabase/database.types';

type SummaryLine = {
  price: number;
  quantity: number;
  title: string;
};

type OrderSummary = {
  deliveryFeeMinor: number | null;
  id: string;
  itemsSummary: Json | null;
  totalAmount: number;
};

type OrderLineRow = {
  orderId: string;
  productId: string | null;
  rawTitle: string;
  qty: number;
};

type SoldMovementRow = {
  productId: string;
  qty: number;
  unitCost: number | null;
};

type PurchaseLotRow = {
  id: string;
  receivedAt: string | null;
  status: string;
};

type PurchaseLotLineRow = {
  landedTotalValue: number | null;
  productId: string;
  purchaseLotId: string;
  qty: number;
};

type ExpenseRow = {
  amountMinor: number;
  categoryCode: string;
};

type ProductRow = {
  id: string;
  title: string;
};

type ProductPair = {
  productId: string | null;
  qty: number;
  revenueMinor: number;
};

export type FinanceProductCostRow = {
  adsAllocatedMinor: number;
  deliveryAllocatedMinor: number;
  landedReceivedMinor: number;
  marginMinor: number;
  officialCogsMinor: number;
  officialUnitCostMinor: number;
  pilotCostMinor: number;
  pilotUnitCostMinor: number;
  productId: string;
  qtySold: number;
  revenueMinor: number;
  title: string;
};

export type FinanceProductCostReport = {
  adsTotalMinor: number;
  deliveryAllocatedMinor: number;
  matchedUnitCount: number;
  productCount: number;
  rows: FinanceProductCostRow[];
  totalAdsAllocatedMinor: number;
  totalLandedReceivedMinor: number;
  totalMarginMinor: number;
  totalOfficialCogsMinor: number;
  totalPilotCostMinor: number;
  totalQtySold: number;
  totalRevenueMinor: number;
  unallocatedDeliveryMinor: number;
};

export type FinanceProductCostInput = {
  expenses: ExpenseRow[];
  fromIso: string;
  orderLines: OrderLineRow[];
  orders: OrderSummary[];
  products: ProductRow[];
  purchaseLotLines: PurchaseLotLineRow[];
  purchaseLots: PurchaseLotRow[];
  soldMovements: SoldMovementRow[];
  toIso: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number {
  const next = Number(value ?? 0);
  return Number.isFinite(next) ? next : 0;
}

function roundHalfUpDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    return 0n;
  }

  return (numerator + denominator / 2n) / denominator;
}

// Les montants peuvent arriver fractionnaires (prix `items_summary` en jsonb,
// `orders.total_amount` en `numeric`). FCFA = entier → on arrondit au minor le
// plus proche AVANT BigInt (jamais BigInt(float), qui lève un RangeError).
function toMinor(value: number): bigint {
  return BigInt(Math.round(Number.isFinite(value) ? value : 0));
}

function parseSummaryLines(value: Json | null): SummaryLine[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!isRecord(item)) {
        return null;
      }

      const title = typeof item.title === 'string' ? item.title.trim() : '';
      if (!title) {
        return null;
      }

      return {
        price: toNumber(item.price),
        quantity: Math.max(0, Math.trunc(toNumber(item.quantity))),
        title,
      };
    })
    .filter((item): item is SummaryLine => item !== null && item.quantity > 0);
}

function normalizeTitle(value: string): string {
  return value.trim().toLocaleLowerCase('fr');
}

function pairOrderLines(orderLines: OrderLineRow[], summaryLines: SummaryLine[]): ProductPair[] {
  const usedOrderIndexes = new Set<number>();

  return summaryLines.map((summary) => {
    const orderIndex = orderLines.findIndex(
      (line, index) =>
        !usedOrderIndexes.has(index) &&
        line.productId !== null &&
        normalizeTitle(line.rawTitle) === normalizeTitle(summary.title),
    );

    if (orderIndex === -1) {
      return {
        productId: null,
        qty: summary.quantity,
        revenueMinor: summary.price * summary.quantity,
      };
    }

    usedOrderIndexes.add(orderIndex);
    const line = orderLines[orderIndex];

    return {
      productId: line.productId,
      qty: summary.quantity,
      revenueMinor: summary.price * summary.quantity,
    };
  });
}

function allocateByWeights(totalMinor: bigint, weights: bigint[]): bigint[] {
  if (weights.length === 0 || totalMinor <= 0n) {
    return Array.from({ length: weights.length }, () => 0n);
  }

  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n);
  if (totalWeight <= 0n) {
    return Array.from({ length: weights.length }, () => 0n);
  }

  const base = weights.map((weight) => (totalMinor * weight) / totalWeight);
  let remainder = totalMinor - base.reduce((sum, value) => sum + value, 0n);

  const order = weights
    .map((weight, index) => ({ index, remainder: (totalMinor * weight) % totalWeight }))
    .sort((left, right) => {
      if (left.remainder === right.remainder) {
        return left.index - right.index;
      }

      return right.remainder > left.remainder ? 1 : -1;
    });

  for (const entry of order) {
    if (remainder <= 0n) {
      break;
    }
    base[entry.index] += 1n;
    remainder -= 1n;
  }

  return base;
}

function groupByProduct(
  rows: Array<{ amountMinor: bigint; productId: string }>,
): Map<string, bigint> {
  const grouped = new Map<string, bigint>();
  for (const row of rows) {
    grouped.set(row.productId, (grouped.get(row.productId) ?? 0n) + row.amountMinor);
  }
  return grouped;
}

function sumBigints(values: bigint[]): bigint {
  return values.reduce((sum, value) => sum + value, 0n);
}

export function computeFinanceProductCostReport(
  input: FinanceProductCostInput,
): FinanceProductCostReport {
  const titleByProductId = new Map(
    input.products.map((product) => [product.id, product.title] as const),
  );

  const revenueRows: Array<{ amountMinor: bigint; productId: string }> = [];
  const quantityRows: Array<{ amountMinor: bigint; productId: string }> = [];
  const matchedPairsByOrder = new Map<string, ProductPair[]>();
  let matchedUnitCount = 0;

  for (const order of input.orders) {
    const summaryLines = parseSummaryLines(order.itemsSummary);
    const orderLines = input.orderLines.filter((line) => line.orderId === order.id);
    const pairs = pairOrderLines(orderLines, summaryLines);
    matchedPairsByOrder.set(order.id, pairs);

    for (const pair of pairs) {
      if (!pair.productId) {
        continue;
      }

      matchedUnitCount += pair.qty;
      revenueRows.push({ amountMinor: toMinor(pair.revenueMinor), productId: pair.productId });
      quantityRows.push({ amountMinor: BigInt(pair.qty), productId: pair.productId });
    }
  }

  const revenueByProduct = groupByProduct(revenueRows);
  const qtyByProduct = groupByProduct(quantityRows);

  const soldByProduct = new Map<string, { cogsMinor: bigint; qtySold: bigint }>();
  for (const movement of input.soldMovements) {
    if (!movement.unitCost || movement.qty <= 0) {
      continue;
    }

    const current = soldByProduct.get(movement.productId) ?? { cogsMinor: 0n, qtySold: 0n };
    current.cogsMinor += toMinor(movement.unitCost) * BigInt(movement.qty);
    current.qtySold += BigInt(movement.qty);
    soldByProduct.set(movement.productId, current);
  }

  const receivedLotIds = new Set(
    input.purchaseLots
      .filter(
        (lot) =>
          lot.status === 'received' &&
          lot.receivedAt !== null &&
          lot.receivedAt >= input.fromIso &&
          lot.receivedAt <= input.toIso,
      )
      .map((lot) => lot.id),
  );
  const landedByProduct = new Map<string, bigint>();
  for (const line of input.purchaseLotLines) {
    const lot = input.purchaseLots.find((candidate) => candidate.id === line.purchaseLotId);
    if (!lot || !receivedLotIds.has(lot.id) || !line.landedTotalValue || line.qty <= 0) {
      continue;
    }
    landedByProduct.set(
      line.productId,
      (landedByProduct.get(line.productId) ?? 0n) + toMinor(line.landedTotalValue ?? 0),
    );
  }

  const adsTotalMinor = input.expenses
    .filter((expense) => expense.categoryCode === 'ADS')
    .reduce((sum, expense) => sum + toMinor(expense.amountMinor), 0n);

  const productIds = [
    ...new Set([...revenueByProduct.keys(), ...soldByProduct.keys(), ...landedByProduct.keys()]),
  ];
  const revenueWeights = productIds.map((productId) => revenueByProduct.get(productId) ?? 0n);
  const qtyWeights = productIds.map((productId) => qtyByProduct.get(productId) ?? 0n);
  const adsWeights =
    sumBigints(revenueWeights) > 0n
      ? revenueWeights
      : qtyWeights.some((value) => value > 0n)
        ? qtyWeights
        : Array.from({ length: productIds.length }, () => 1n);
  const adsAllocations = allocateByWeights(adsTotalMinor, adsWeights);
  const adsByProduct = new Map<string, bigint>();
  productIds.forEach((productId, index) => {
    adsByProduct.set(productId, adsAllocations[index] ?? 0n);
  });

  const totalDeliveryFeesMinor = input.orders.reduce(
    (sum, order) => sum + toMinor(order.deliveryFeeMinor ?? 0),
    0n,
  );
  const deliveryByProduct = new Map<string, bigint>();
  let allocatedDeliveryMinor = 0n;

  for (const order of input.orders) {
    const pairs = matchedPairsByOrder.get(order.id) ?? [];
    const unitProducts: (string | null)[] = [];

    for (const pair of pairs) {
      for (let index = 0; index < pair.qty; index += 1) {
        unitProducts.push(pair.productId);
      }
    }

    if (unitProducts.length === 0) {
      continue;
    }

    const shares = allocateByWeights(
      toMinor(order.deliveryFeeMinor ?? 0),
      Array.from({ length: unitProducts.length }, () => 1n),
    );

    unitProducts.forEach((productId, index) => {
      if (!productId) {
        return;
      }

      deliveryByProduct.set(productId, (deliveryByProduct.get(productId) ?? 0n) + shares[index]);
      allocatedDeliveryMinor += shares[index];
    });
  }

  const rows = productIds
    .map((productId) => {
      const revenueMinor = revenueByProduct.get(productId) ?? 0n;
      const qtySold = qtyByProduct.get(productId) ?? 0n;
      const officialCogsMinor = soldByProduct.get(productId)?.cogsMinor ?? 0n;
      const landedReceivedMinor = landedByProduct.get(productId) ?? 0n;
      const adsAllocatedMinor = adsByProduct.get(productId) ?? 0n;
      const deliveryAllocatedMinor = deliveryByProduct.get(productId) ?? 0n;
      const pilotCostMinor = landedReceivedMinor + adsAllocatedMinor + deliveryAllocatedMinor;
      const marginMinor =
        revenueMinor - officialCogsMinor - adsAllocatedMinor - deliveryAllocatedMinor;

      return {
        adsAllocatedMinor: Number(adsAllocatedMinor),
        deliveryAllocatedMinor: Number(deliveryAllocatedMinor),
        landedReceivedMinor: Number(landedReceivedMinor),
        marginMinor: Number(marginMinor),
        officialCogsMinor: Number(officialCogsMinor),
        officialUnitCostMinor: Number(
          qtySold > 0n ? roundHalfUpDiv(officialCogsMinor, qtySold) : 0n,
        ),
        pilotCostMinor: Number(pilotCostMinor),
        pilotUnitCostMinor: Number(qtySold > 0n ? roundHalfUpDiv(pilotCostMinor, qtySold) : 0n),
        productId,
        qtySold: Number(qtySold),
        revenueMinor: Number(revenueMinor),
        title: titleByProductId.get(productId) ?? productId,
      } satisfies FinanceProductCostRow;
    })
    .filter((row) => row.qtySold > 0)
    .sort((left, right) => right.revenueMinor - left.revenueMinor || right.qtySold - left.qtySold);

  const totalAdsAllocatedMinor = rows.reduce((sum, row) => sum + row.adsAllocatedMinor, 0);
  const totalDeliveryAllocatedMinor = rows.reduce(
    (sum, row) => sum + row.deliveryAllocatedMinor,
    0,
  );
  const totalLandedReceivedMinor = rows.reduce((sum, row) => sum + row.landedReceivedMinor, 0);
  const totalOfficialCogsMinor = rows.reduce((sum, row) => sum + row.officialCogsMinor, 0);
  const totalPilotCostMinor = rows.reduce((sum, row) => sum + row.pilotCostMinor, 0);
  const totalMarginMinor = rows.reduce((sum, row) => sum + row.marginMinor, 0);
  const totalQtySold = rows.reduce((sum, row) => sum + row.qtySold, 0);
  const totalRevenueMinor = rows.reduce((sum, row) => sum + row.revenueMinor, 0);

  return {
    adsTotalMinor: Number(adsTotalMinor),
    deliveryAllocatedMinor: totalDeliveryAllocatedMinor,
    matchedUnitCount,
    productCount: rows.length,
    rows,
    totalAdsAllocatedMinor,
    totalLandedReceivedMinor,
    totalMarginMinor,
    totalOfficialCogsMinor,
    totalPilotCostMinor,
    totalQtySold,
    totalRevenueMinor,
    unallocatedDeliveryMinor: Number(totalDeliveryFeesMinor - allocatedDeliveryMinor),
  };
}

export async function fetchFinanceProductCostReport(
  admin: FinanceAdminClient,
  merchantId: string,
  fromIso: string,
  toIso: string,
): Promise<FinanceProductCostReport> {
  const [
    ordersRes,
    soldRes,
    purchaseLotsRes,
    purchaseLotLinesRes,
    expensesRes,
    productsRes,
    categoriesRes,
  ] = await Promise.all([
    admin
      .from('orders')
      .select('id, total_amount, delivery_fee_minor, items_summary')
      .eq('merchant_account_id', merchantId)
      .gte('cash_collected_at', fromIso)
      .lte('cash_collected_at', toIso),
    admin
      .from('stock_movement')
      .select('product_id, qty, unit_cost')
      .eq('merchant_account_id', merchantId)
      .eq('movement_type', 'sold')
      .gte('created_at', fromIso)
      .lte('created_at', toIso),
    admin
      .from('purchase_lot')
      .select('id, received_at, status')
      .eq('merchant_account_id', merchantId),
    admin
      .from('purchase_lot_line')
      .select('purchase_lot_id, product_id, qty, landed_total_value')
      .eq('merchant_account_id', merchantId),
    admin
      .from('expense')
      .select('amount_minor, category_id')
      .eq('merchant_account_id', merchantId)
      .gte('spent_at', fromIso.slice(0, 10))
      .lte('spent_at', toIso.slice(0, 10)),
    admin.from('product').select('id, title').eq('merchant_account_id', merchantId),
    admin.from('expense_category').select('id, code').eq('merchant_account_id', merchantId),
  ]);

  if (
    ordersRes.error ||
    soldRes.error ||
    purchaseLotsRes.error ||
    purchaseLotLinesRes.error ||
    expensesRes.error ||
    productsRes.error ||
    categoriesRes.error
  ) {
    throw new Error('finance_product_cost_error');
  }

  const orderIds = (ordersRes.data ?? []).map((order) => order.id);
  const orderLinesRes =
    orderIds.length > 0
      ? await admin
          .from('order_line')
          .select('order_id, product_id, raw_title, qty')
          .eq('merchant_account_id', merchantId)
          .in('order_id', orderIds)
      : { data: [], error: null };

  if (orderLinesRes.error) {
    throw new Error('finance_product_cost_error');
  }

  return computeFinanceProductCostReport({
    expenses: (expensesRes.data ?? []).map((expense) => {
      const category = (categoriesRes.data ?? []).find((cat) => cat.id === expense.category_id);
      return {
        amountMinor: expense.amount_minor,
        categoryCode: category?.code ?? 'OTHER',
      };
    }),
    fromIso,
    orderLines: (orderLinesRes.data ?? []).map((line) => ({
      orderId: line.order_id,
      productId: line.product_id,
      rawTitle: line.raw_title,
      qty: line.qty,
    })),
    orders: (ordersRes.data ?? []).map((order) => ({
      deliveryFeeMinor: order.delivery_fee_minor,
      id: order.id,
      itemsSummary: order.items_summary,
      totalAmount: order.total_amount,
    })),
    products: (productsRes.data ?? []).map((product) => ({
      id: product.id,
      title: product.title,
    })),
    purchaseLotLines: (purchaseLotLinesRes.data ?? []).map((line) => ({
      landedTotalValue: line.landed_total_value,
      productId: line.product_id,
      purchaseLotId: line.purchase_lot_id,
      qty: line.qty,
    })),
    purchaseLots: (purchaseLotsRes.data ?? []).map((lot) => ({
      id: lot.id,
      receivedAt: lot.received_at,
      status: lot.status,
    })),
    soldMovements: (soldRes.data ?? []).map((movement) => ({
      productId: movement.product_id,
      qty: movement.qty,
      unitCost: movement.unit_cost,
    })),
    toIso,
  });
}
