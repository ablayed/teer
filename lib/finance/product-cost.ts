import { fetchAllPages, fetchFinanceCollectedJoins } from '@/lib/finance/finance-joins';
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

type ExpenseRow = {
  amountMinor: number;
  categoryCode: string;
};

type ProductRow = {
  id: string;
  title: string;
  // `null` = produit jamais costé (distinct de `0` = coût assumé, ex. cadeau).
  unitCost: number | null;
};

type ProductPair = {
  productId: string | null;
  qty: number;
  revenueMinor: number;
};

// En dessous de ce seuil de ventes sur la période, le coût UNITAIRE (pub/livraison
// réparties sur 1-2 ventes) n'a pas de sens → on masque l'unitaire et on n'affiche
// que les totaux période. Cf. §2.3 (garde-fou faible volume).
export const LOW_VOLUME_THRESHOLD = 3;

export type FinanceProductCostRow = {
  adsAllocatedMinor: number;
  // `true` quand le prix d'achat est inconnu (jamais costé) → on n'affiche pas 0.
  costMissing: boolean;
  deliveryAllocatedMinor: number;
  // `true` quand le prix d'achat vient du coût catalogue (unit_cost) faute de COGS
  // figé sur la période → estimation (badge), pas le CUMP exact. Précédent 6c.
  estimated: boolean;
  // `true` quand qtySold < seuil → l'unitaire n'est pas fiable, on montre les totaux.
  lowVolume: boolean;
  // Bénéfice avant pub et livraison = CA − prix d'achat (base A, CUMP figé).
  profitBeforeMinor: number;
  // Bénéfice après pub et livraison = CA − coût total (base B).
  profitAfterMinor: number;
  productId: string;
  // Prix d'achat total = CUMP figé × qté vendue (base A, mouvements `sold`).
  purchasePriceMinor: number;
  purchaseUnitMinor: number;
  qtySold: number;
  revenueMinor: number;
  // Coût total (tout compris) = prix d'achat + pub + livraison (base B).
  totalCostMinor: number;
  totalCostUnitMinor: number;
  title: string;
};

export type FinanceProductCostReport = {
  adsTotalMinor: number;
  lowVolumeThreshold: number;
  matchedUnitCount: number;
  productCount: number;
  rows: FinanceProductCostRow[];
  totalAdsAllocatedMinor: number;
  totalDeliveryAllocatedMinor: number;
  totalProfitAfterMinor: number;
  totalProfitBeforeMinor: number;
  totalPurchasePriceMinor: number;
  totalCostMinor: number;
  totalQtySold: number;
  totalRevenueMinor: number;
  unallocatedDeliveryMinor: number;
};

export type FinanceProductCostInput = {
  expenses: ExpenseRow[];
  orderLines: OrderLineRow[];
  orders: OrderSummary[];
  products: ProductRow[];
  soldMovements: SoldMovementRow[];
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
  // `unit_cost` du produit. ATTENTION : la colonne est `bigint NOT NULL DEFAULT 0`
  // (migration 0027) → un produit jamais costé vaut 0, pas null. On ne peut donc PAS
  // distinguer « 0 assumé » de « jamais costé » : par §2.4 (« inconnu/0 »), 0 +
  // aucun COGS figé = coût manquant (badge), jamais un 0 silencieux à 100 % de marge.
  // unit_cost > 0 sert de repli estimé quand aucun COGS figé n'existe sur la période.
  const unitCostByProductId = new Map(
    input.products.map((product) => [product.id, product.unitCost ?? 0] as const),
  );

  // Index une seule fois (évite un `.filter` O(commandes × lignes) par commande).
  const orderLinesByOrderId = new Map<string, OrderLineRow[]>();
  for (const line of input.orderLines) {
    const bucket = orderLinesByOrderId.get(line.orderId);
    if (bucket) {
      bucket.push(line);
    } else {
      orderLinesByOrderId.set(line.orderId, [line]);
    }
  }

  const revenueRows: Array<{ amountMinor: bigint; productId: string }> = [];
  const quantityRows: Array<{ amountMinor: bigint; productId: string }> = [];
  const matchedPairsByOrder = new Map<string, ProductPair[]>();
  let matchedUnitCount = 0;

  for (const order of input.orders) {
    const summaryLines = parseSummaryLines(order.itemsSummary);
    const orderLines = orderLinesByOrderId.get(order.id) ?? [];
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

  // Prix d'achat (base A) = CUMP figé porté par les mouvements `sold` (×qté vendue).
  // C'est la SEULE composante coût d'achat de (B) : on n'utilise plus « lots reçus
  // dans la période ÷ qté vendue », qui faisait exploser le coût à faible volume.
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

  const adsTotalMinor = input.expenses
    .filter((expense) => expense.categoryCode === 'ADS')
    .reduce((sum, expense) => sum + toMinor(expense.amountMinor), 0n);

  const productIds = [...new Set([...revenueByProduct.keys(), ...soldByProduct.keys()])];
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
      const frozenCogsMinor = soldByProduct.get(productId)?.cogsMinor ?? 0n;
      const unitCost = unitCostByProductId.get(productId) ?? 0;
      const adsAllocatedMinor = adsByProduct.get(productId) ?? 0n;
      const deliveryAllocatedMinor = deliveryByProduct.get(productId) ?? 0n;

      // Prix d'achat (base A) : COGS figé prioritaire ; sinon repli estimé sur le
      // coût catalogue unit_cost (×qté). Aucun des deux (unit_cost 0) → coût manquant
      // (badge + « — » sur les bénéfices), jamais un 0 silencieux.
      let purchasePriceMinor: bigint;
      let estimated: boolean;
      let costMissing: boolean;
      if (frozenCogsMinor > 0n) {
        purchasePriceMinor = frozenCogsMinor;
        estimated = false;
        costMissing = false;
      } else if (unitCost > 0) {
        purchasePriceMinor = toMinor(unitCost) * qtySold;
        estimated = true;
        costMissing = false;
      } else {
        purchasePriceMinor = 0n;
        estimated = false;
        costMissing = true;
      }

      // Coût total (B) = prix d'achat (A) + pub + livraison. Apparié au CA :
      // bénéfice avant = CA − prix d'achat ; bénéfice après = CA − coût total.
      const totalCostMinor = purchasePriceMinor + adsAllocatedMinor + deliveryAllocatedMinor;
      const profitBeforeMinor = revenueMinor - purchasePriceMinor;
      const profitAfterMinor = revenueMinor - totalCostMinor;

      return {
        adsAllocatedMinor: Number(adsAllocatedMinor),
        costMissing,
        deliveryAllocatedMinor: Number(deliveryAllocatedMinor),
        estimated,
        lowVolume: qtySold < BigInt(LOW_VOLUME_THRESHOLD),
        profitAfterMinor: Number(profitAfterMinor),
        profitBeforeMinor: Number(profitBeforeMinor),
        productId,
        purchasePriceMinor: Number(purchasePriceMinor),
        purchaseUnitMinor: Number(qtySold > 0n ? roundHalfUpDiv(purchasePriceMinor, qtySold) : 0n),
        qtySold: Number(qtySold),
        revenueMinor: Number(revenueMinor),
        title: titleByProductId.get(productId) ?? productId,
        totalCostMinor: Number(totalCostMinor),
        totalCostUnitMinor: Number(qtySold > 0n ? roundHalfUpDiv(totalCostMinor, qtySold) : 0n),
      } satisfies FinanceProductCostRow;
    })
    .filter((row) => row.qtySold > 0)
    .sort((left, right) => right.revenueMinor - left.revenueMinor || right.qtySold - left.qtySold);

  const totalAdsAllocatedMinor = rows.reduce((sum, row) => sum + row.adsAllocatedMinor, 0);
  const totalDeliveryAllocatedMinor = rows.reduce(
    (sum, row) => sum + row.deliveryAllocatedMinor,
    0,
  );
  const totalPurchasePriceMinor = rows.reduce((sum, row) => sum + row.purchasePriceMinor, 0);
  const totalCostMinor = rows.reduce((sum, row) => sum + row.totalCostMinor, 0);
  const totalProfitBeforeMinor = rows.reduce((sum, row) => sum + row.profitBeforeMinor, 0);
  const totalProfitAfterMinor = rows.reduce((sum, row) => sum + row.profitAfterMinor, 0);
  const totalQtySold = rows.reduce((sum, row) => sum + row.qtySold, 0);
  const totalRevenueMinor = rows.reduce((sum, row) => sum + row.revenueMinor, 0);

  return {
    adsTotalMinor: Number(adsTotalMinor),
    lowVolumeThreshold: LOW_VOLUME_THRESHOLD,
    matchedUnitCount,
    productCount: rows.length,
    rows,
    totalAdsAllocatedMinor,
    totalCostMinor,
    totalDeliveryAllocatedMinor,
    totalProfitAfterMinor,
    totalProfitBeforeMinor,
    totalPurchasePriceMinor,
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
  shopId?: string | null,
): Promise<FinanceProductCostReport> {
  // Lot 5 : select fenêtré paginé .range() (n'alimente plus aucun .in() une fois les
  // jointures order_line/stock_movement déplacées vers la RPC get_finance_collected_joins).
  const ordersPage = (offset: number) => {
    let query = admin
      .from('orders')
      .select('id, total_amount, delivery_fee_minor, items_summary')
      .eq('merchant_account_id', merchantId)
      .gte('cash_collected_at', fromIso)
      .lte('cash_collected_at', toIso)
      .order('id', { ascending: true });

    if (shopId) {
      query = query.eq('shop_id', shopId);
    }

    return query.range(offset, offset + 499);
  };

  // Catalogue produits paginé .range() : select tenant-wide sans fenêtre, à risque sur un
  // gros catalogue (>1000 SKU) indépendamment du volume de commandes (Lot 5).
  const productsPage = (offset: number) =>
    admin
      .from('product')
      .select('id, title, unit_cost')
      .eq('merchant_account_id', merchantId)
      .order('id', { ascending: true })
      .range(offset, offset + 499);

  const [ordersResult, productsResult, expensesRes, categoriesRes, collectedJoins] =
    await Promise.all([
      fetchAllPages(ordersPage),
      fetchAllPages(productsPage),
      admin
        .from('expense')
        .select('amount_minor, category_id')
        .eq('merchant_account_id', merchantId)
        .gte('spent_at', fromIso.slice(0, 10))
        .lte('spent_at', toIso.slice(0, 10)),
      admin.from('expense_category').select('id, code').eq('merchant_account_id', merchantId),
      fetchFinanceCollectedJoins(admin, merchantId, fromIso, toIso, shopId),
    ]);

  if (ordersResult.error || productsResult.error || expensesRes.error || categoriesRes.error) {
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
    orderLines: collectedJoins.orderLines.map((line) => ({
      orderId: line.order_id,
      productId: line.product_id,
      rawTitle: line.raw_title,
      qty: line.qty,
    })),
    orders: ordersResult.data.map((order) => ({
      deliveryFeeMinor: order.delivery_fee_minor,
      id: order.id,
      itemsSummary: order.items_summary,
      totalAmount: order.total_amount,
    })),
    products: productsResult.data.map((product) => ({
      id: product.id,
      title: product.title,
      unitCost: product.unit_cost,
    })),
    soldMovements: collectedJoins.soldMovements.map((movement) => ({
      productId: movement.product_id,
      qty: movement.qty,
      unitCost: movement.unit_cost,
    })),
  });
}
