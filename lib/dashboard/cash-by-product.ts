import {
  type FinanceRevenueByProductRow,
  computeFinanceCollectedRevenueByProduct,
} from '@/lib/finance/product-cost';
import type { Json } from '@/lib/supabase/database.types';

type DashboardCashByProductOrder = {
  id: string;
  itemsSummary: Json | null;
  totalAmount: number;
};

type DashboardCashByProductOrderLine = {
  orderId: string;
  productId: string | null;
  qty: number;
  rawTitle: string;
};

type DashboardCashByProductProduct = {
  id: string;
  title: string;
  unitCost: number | null;
};

export type DashboardCashCollectedByProductData = {
  items: FinanceRevenueByProductRow[];
  totalMinor: number;
};

export function buildDashboardCashCollectedByProduct(input: {
  orderLines: DashboardCashByProductOrderLine[];
  orders: DashboardCashByProductOrder[];
  products: DashboardCashByProductProduct[];
}): DashboardCashCollectedByProductData {
  const eligibleOrders = input.orders.filter((order) => order.totalAmount > 0);
  const eligibleOrderIds = new Set(eligibleOrders.map((order) => order.id));
  const eligibleOrderLines = input.orderLines.filter((line) => eligibleOrderIds.has(line.orderId));
  const items = computeFinanceCollectedRevenueByProduct({
    orderLines: eligibleOrderLines,
    orders: eligibleOrders.map((order) => ({
      deliveryFeeMinor: 0,
      id: order.id,
      itemsSummary: order.itemsSummary,
      totalAmount: order.totalAmount,
    })),
    products: input.products,
  }).slice(0, 10);

  return {
    items,
    totalMinor: items.reduce((sum, item) => sum + item.revenueMinor, 0),
  };
}
