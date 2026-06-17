import type { FinanceAdminClient } from '@/lib/finance/report-data';

type DriverRow = {
  fullName: string;
  id: string;
};

type SoldMovementRow = {
  driverId: string | null;
  qty: number;
  unitCost: number | null;
};

type OrderRow = {
  assignedDriverId: string | null;
  deliveryFeeMinor: number | null;
  totalAmount: number;
};

export type FinanceDriverCostRow = {
  cogsMinor: number;
  driverId: string;
  marginMinor: number | null;
  qtySold: number;
  revenueMinor: number | null;
  title: string;
  unitCogsMinor: number;
};

export type FinanceDriverCostReport = {
  rows: FinanceDriverCostRow[];
  totalCogsMinor: number;
  totalQtySold: number;
  totalRevenueMinor: number;
};

function roundHalfUpDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    return 0n;
  }

  return (numerator + denominator / 2n) / denominator;
}

function groupByDriver(
  rows: Array<{ driverId: string; amountMinor: bigint; qty?: bigint }>,
): Map<string, { amountMinor: bigint; qtySold: bigint }> {
  const grouped = new Map<string, { amountMinor: bigint; qtySold: bigint }>();

  for (const row of rows) {
    const current = grouped.get(row.driverId) ?? { amountMinor: 0n, qtySold: 0n };
    current.amountMinor += row.amountMinor;
    current.qtySold += row.qty ?? 0n;
    grouped.set(row.driverId, current);
  }

  return grouped;
}

export type FinanceDriverCostInput = {
  drivers: DriverRow[];
  orders: OrderRow[];
  soldMovements: SoldMovementRow[];
};

export function computeFinanceDriverCostReport(
  input: FinanceDriverCostInput,
): FinanceDriverCostReport {
  const driverTitleById = new Map(
    input.drivers.map((driver) => [driver.id, driver.fullName] as const),
  );

  const soldRows: Array<{ driverId: string; amountMinor: bigint; qty: bigint }> = [];
  for (const movement of input.soldMovements) {
    if (!movement.driverId || movement.qty <= 0 || movement.unitCost === null) {
      continue;
    }
    soldRows.push({
      amountMinor: BigInt(movement.qty) * BigInt(movement.unitCost),
      driverId: movement.driverId,
      qty: BigInt(movement.qty),
    });
  }

  const revenueRows: Array<{ driverId: string; amountMinor: bigint }> = [];
  for (const order of input.orders) {
    if (!order.assignedDriverId) {
      continue;
    }

    revenueRows.push({
      amountMinor: BigInt(order.totalAmount - (order.deliveryFeeMinor ?? 0)),
      driverId: order.assignedDriverId,
    });
  }

  const soldByDriver = groupByDriver(soldRows);
  const revenueByDriver = groupByDriver(revenueRows);

  const driverIds = [...new Set([...soldByDriver.keys(), ...revenueByDriver.keys()])];

  const rows = driverIds
    .map((driverId) => {
      const sold = soldByDriver.get(driverId) ?? { amountMinor: 0n, qtySold: 0n };
      const revenue = revenueByDriver.get(driverId)?.amountMinor ?? null;
      const marginMinor = revenue === null ? null : revenue - sold.amountMinor;
      const unitCogsMinor = sold.qtySold > 0n ? roundHalfUpDiv(sold.amountMinor, sold.qtySold) : 0n;

      return {
        cogsMinor: Number(sold.amountMinor),
        driverId,
        marginMinor: marginMinor === null ? null : Number(marginMinor),
        qtySold: Number(sold.qtySold),
        revenueMinor: revenue === null ? null : Number(revenue),
        title: driverTitleById.get(driverId) ?? driverId,
        unitCogsMinor: Number(unitCogsMinor),
      } satisfies FinanceDriverCostRow;
    })
    .sort((left, right) => right.cogsMinor - left.cogsMinor || right.qtySold - left.qtySold);

  return {
    rows,
    totalCogsMinor: rows.reduce((sum, row) => sum + row.cogsMinor, 0),
    totalQtySold: rows.reduce((sum, row) => sum + row.qtySold, 0),
    totalRevenueMinor: rows.reduce((sum, row) => sum + (row.revenueMinor ?? 0), 0),
  };
}

export async function fetchFinanceDriverCostReport(
  admin: FinanceAdminClient,
  merchantId: string,
  fromIso: string,
  toIso: string,
): Promise<FinanceDriverCostReport> {
  const [driversRes, ordersRes, soldRes] = await Promise.all([
    admin
      .from('driver')
      .select('id, full_name')
      .eq('merchant_account_id', merchantId)
      .order('full_name', { ascending: true }),
    admin
      .from('orders')
      .select('assigned_driver_id, delivery_fee_minor, total_amount')
      .eq('merchant_account_id', merchantId)
      .gte('cash_collected_at', fromIso)
      .lte('cash_collected_at', toIso),
    admin
      .from('stock_movement')
      .select('driver_id, qty, unit_cost')
      .eq('merchant_account_id', merchantId)
      .eq('movement_type', 'sold')
      .gte('created_at', fromIso)
      .lte('created_at', toIso),
  ]);

  if (driversRes.error || ordersRes.error || soldRes.error) {
    throw new Error('finance_driver_cost_error');
  }

  return computeFinanceDriverCostReport({
    drivers: (driversRes.data ?? []).map((driver) => ({
      fullName: driver.full_name,
      id: driver.id,
    })),
    orders: (ordersRes.data ?? []).map((order) => ({
      assignedDriverId: order.assigned_driver_id,
      deliveryFeeMinor: order.delivery_fee_minor,
      totalAmount: order.total_amount,
    })),
    soldMovements: (soldRes.data ?? []).map((movement) => ({
      driverId: movement.driver_id,
      qty: movement.qty,
      unitCost: movement.unit_cost,
    })),
  });
}
