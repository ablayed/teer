import type { Json } from '@/lib/supabase/database.types';

const RTO_DELIVERY_STATES = new Set(['failed', 'returned']);
const RTO_OUTCOME_STATES = new Set(['delivered', 'failed', 'returned']);
const CANCELLATION_PRIOR_STATES = new Set(['unassigned', 'scheduled']);

export type LossAnalyticsOrder = {
  assignedDriverId: string | null;
  cancelReason: string | null;
  createdAt: string;
  customerId: string | null;
  deliveryState: string | null;
  id: string;
  orderState: string | null;
  source: string | null;
};

export type LossAnalyticsOrderLine = {
  matchStatus: string;
  orderId: string;
  productId: string | null;
  qty: number;
  rawSku: string | null;
  rawTitle: string;
};

export type LossAnalyticsCustomer = {
  address: Json | null;
  fullName: string | null;
  id: string;
  shippingAddress: Json | null;
};

export type LossAnalyticsDriver = {
  fullName: string;
  id: string;
};

export type LossAnalyticsReliability = {
  customerId: string;
  fullName: string | null;
  orderCount: number;
  refusedCount: number;
  score: number;
  tier: string;
};

export type LossAnalyticsAuditLog = {
  createdAt: string;
  payload: Json | null;
  resourceId: string | null;
};

type TransitionDimensions = {
  deliveryState: string | null;
  orderState: string | null;
};

type LossEventType = 'cancellation' | 'return' | 'rto' | 'delivered_outcome';

type LossEvent = {
  createdAt: string;
  orderId: string;
  type: LossEventType;
};

type ProductAggregate = {
  key: string;
  name: string;
  productId: string | null;
  sku: string | null;
  totalOrders: number;
  cancellationOrders: number;
  returnOrders: number;
  deliveredOrders: number;
  rtoOrders: number;
  outcomeOrders: number;
  cancellationUnits: number;
  returnUnits: number;
  rtoUnits: number;
  deliveredUnits: number;
};

type ZoneAggregate = {
  label: string;
  totalOrders: number;
  cancellationOrders: number;
  returnOrders: number;
  deliveredOrders: number;
  rtoOrders: number;
  outcomeOrders: number;
};

type DriverAggregate = {
  driverId: string;
  driverName: string;
  deliveredOrders: number;
  outcomeOrders: number;
  rtoOrders: number;
  returnOrders: number;
};

export type LossAnalyticsSummary = {
  cancellationCount: number;
  cancellationRate: number;
  deliveredCount: number;
  returnCount: number;
  returnRate: number;
  rtoCount: number;
  rtoDenominator: number;
  rtoRate: number;
  totalOrders: number;
};

export type LossAnalyticsSourceScorecard = {
  cancellationCount: number;
  cancellationRate: number;
  completionRate: number;
  deliveredCount: number;
  outcomeOrders: number;
  returnCount: number;
  returnRate: number;
  rtoCount: number;
  rtoRate: number;
  source: string;
  totalOrders: number;
};

export type LossAnalyticsTrendPoint = {
  cancellationCount: number;
  date: string;
  deliveredCount: number;
  returnCount: number;
  rtoCount: number;
  rtoDenominator: number;
  rtoRate: number;
};

export type LossAnalyticsProductLoss = {
  cancellationOrders: number;
  cancellationRate: number;
  cancellationUnits: number;
  deliveredOrders: number;
  deliveredUnits: number;
  name: string;
  outcomeOrders: number;
  productId: string | null;
  returnOrders: number;
  returnRate: number;
  returnUnits: number;
  rtoOrders: number;
  rtoRate: number;
  rtoUnits: number;
  sku: string | null;
  totalOrders: number;
};

export type LossAnalyticsZoneLoss = {
  cancellationOrders: number;
  cancellationRate: number;
  deliveredOrders: number;
  label: string;
  outcomeOrders: number;
  returnOrders: number;
  returnRate: number;
  rtoOrders: number;
  rtoRate: number;
  totalOrders: number;
};

export type LossAnalyticsDriverLoss = {
  deliveredOrders: number;
  driverId: string;
  driverName: string;
  outcomeOrders: number;
  returnOrders: number;
  returnRate: number;
  rtoOrders: number;
  rtoRate: number;
};

export type LossAnalyticsReason = {
  count: number;
  reason: string;
};

export type LossAnalyticsRepeatedRefuser = {
  customerId: string;
  fullName: string | null;
  orderCount: number;
  refusedCount: number;
  score: number;
  tier: string;
};

export type LossAnalyticsResult = {
  driverPerformance: LossAnalyticsDriverLoss[];
  productLosses: LossAnalyticsProductLoss[];
  reasonBreakdown: LossAnalyticsReason[];
  repeatedRefusers: LossAnalyticsRepeatedRefuser[];
  sourceScorecard: LossAnalyticsSourceScorecard[];
  summary: LossAnalyticsSummary;
  trends: LossAnalyticsTrendPoint[];
  zoneLosses: LossAnalyticsZoneLoss[];
};

function isRecord(value: Json | null | undefined): value is Record<string, Json | undefined> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, Json | undefined>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function dayWindow(fromISO: string, toISO: string): string[] {
  const start = new Date(`${fromISO.slice(0, 10)}T00:00:00.000Z`);
  const end = new Date(`${toISO.slice(0, 10)}T00:00:00.000Z`);
  const keys: string[] = [];
  const cursor = new Date(start);
  let guard = 0;

  while (cursor.getTime() <= end.getTime() && guard < 366) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    guard += 1;
  }

  return keys;
}

function eventDay(iso: string): string {
  return iso.slice(0, 10);
}

function parseDimensions(
  payload: Json | null,
  key: 'nextDimensions' | 'priorDimensions',
): TransitionDimensions {
  if (!isRecord(payload) || !isRecord(payload[key])) {
    return { deliveryState: null, orderState: null };
  }

  const dimensions = payload[key] as Record<string, Json | undefined>;

  return {
    deliveryState: stringField(dimensions, 'delivery_state'),
    orderState: stringField(dimensions, 'order_state'),
  };
}

function parseLossEvents(auditLogs: LossAnalyticsAuditLog[]): LossEvent[] {
  const events: LossEvent[] = [];

  for (const log of auditLogs) {
    if (!log.resourceId) {
      continue;
    }

    const prior = parseDimensions(log.payload, 'priorDimensions');
    const next = parseDimensions(log.payload, 'nextDimensions');

    if (
      next.orderState === 'cancelled' &&
      prior.deliveryState !== null &&
      CANCELLATION_PRIOR_STATES.has(prior.deliveryState)
    ) {
      events.push({ createdAt: log.createdAt, orderId: log.resourceId, type: 'cancellation' });
    }

    if (
      (next.orderState === 'returned' || next.deliveryState === 'returned') &&
      (prior.deliveryState === 'delivered' || prior.orderState === 'completed')
    ) {
      events.push({ createdAt: log.createdAt, orderId: log.resourceId, type: 'return' });
    }

    if (next.deliveryState !== null && RTO_DELIVERY_STATES.has(next.deliveryState)) {
      events.push({ createdAt: log.createdAt, orderId: log.resourceId, type: 'rto' });
    }

    if (next.deliveryState === 'delivered') {
      events.push({ createdAt: log.createdAt, orderId: log.resourceId, type: 'delivered_outcome' });
    }
  }

  return events;
}

function lossSource(source: string | null): string {
  return source?.trim() || 'inconnu';
}

function zoneLabel(customer: LossAnalyticsCustomer | undefined): string {
  const sources = [customer?.address, customer?.shippingAddress];

  for (const source of sources) {
    if (!isRecord(source)) {
      continue;
    }

    const region = stringField(source, 'region');
    if (region) {
      return region;
    }

    const address1 = stringField(source, 'address1');
    if (address1) {
      return address1;
    }

    const city = stringField(source, 'city');
    if (city) {
      return city;
    }
  }

  return 'Zone inconnue';
}

function rateSummary(
  totalOrders: number,
  cancellationCount: number,
  returnCount: number,
  deliveredCount: number,
  rtoCount: number,
): LossAnalyticsSummary {
  const rtoDenominator = deliveredCount + rtoCount;
  const returnDenominator = deliveredCount + returnCount;

  return {
    cancellationCount,
    cancellationRate: ratio(cancellationCount, totalOrders),
    deliveredCount,
    returnCount,
    returnRate: ratio(returnCount, returnDenominator),
    rtoCount,
    rtoDenominator,
    rtoRate: ratio(rtoCount, rtoDenominator),
    totalOrders,
  };
}

export function computeLossAnalytics({
  auditLogs,
  customers,
  drivers,
  fromISO,
  orderLines,
  orders,
  reliability,
  toISO,
}: {
  auditLogs: LossAnalyticsAuditLog[];
  customers: LossAnalyticsCustomer[];
  drivers: LossAnalyticsDriver[];
  fromISO: string;
  orderLines: LossAnalyticsOrderLine[];
  orders: LossAnalyticsOrder[];
  reliability: LossAnalyticsReliability[];
  toISO: string;
}): LossAnalyticsResult {
  const events = parseLossEvents(auditLogs);
  const eventsByOrderId = new Map<string, Set<LossEventType>>();
  const customerById = new Map(customers.map((customer) => [customer.id, customer]));
  const driverNameById = new Map(drivers.map((driver) => [driver.id, driver.fullName]));
  const orderLinesByOrderId = new Map<string, LossAnalyticsOrderLine[]>();

  for (const line of orderLines) {
    const current = orderLinesByOrderId.get(line.orderId) ?? [];
    current.push(line);
    orderLinesByOrderId.set(line.orderId, current);
  }

  for (const event of events) {
    const current = eventsByOrderId.get(event.orderId) ?? new Set<LossEventType>();
    current.add(event.type);
    eventsByOrderId.set(event.orderId, current);
  }

  let deliveredCount = 0;
  let rtoCount = 0;
  let cancellationCount = 0;
  let returnCount = 0;

  const sourceAggregates = new Map<string, LossAnalyticsSummary>();
  const productAggregates = new Map<string, ProductAggregate>();
  const zoneAggregates = new Map<string, ZoneAggregate>();
  const driverAggregates = new Map<string, DriverAggregate>();
  const reasonCounts = new Map<string, number>();

  for (const order of orders) {
    const sourceKey = lossSource(order.source);
    const customer = order.customerId ? customerById.get(order.customerId) : undefined;
    const zoneKey = zoneLabel(customer);
    const orderEvents = eventsByOrderId.get(order.id) ?? new Set<LossEventType>();
    const isCancellation = orderEvents.has('cancellation');
    const isReturn = orderEvents.has('return');
    const isRto = order.deliveryState !== null && RTO_DELIVERY_STATES.has(order.deliveryState);
    const isDelivered = order.deliveryState === 'delivered';
    const hasOutcome = order.deliveryState !== null && RTO_OUTCOME_STATES.has(order.deliveryState);

    if (isCancellation) {
      cancellationCount += 1;
    }

    if (isReturn) {
      returnCount += 1;
    }

    if (isRto) {
      rtoCount += 1;
    }

    if (isDelivered) {
      deliveredCount += 1;
    }

    const nextSource = sourceAggregates.get(sourceKey) ?? rateSummary(0, 0, 0, 0, 0);
    sourceAggregates.set(
      sourceKey,
      rateSummary(
        nextSource.totalOrders + 1,
        nextSource.cancellationCount + (isCancellation ? 1 : 0),
        nextSource.returnCount + (isReturn ? 1 : 0),
        nextSource.deliveredCount + (isDelivered ? 1 : 0),
        nextSource.rtoCount + (isRto ? 1 : 0),
      ),
    );

    const nextZone = zoneAggregates.get(zoneKey) ?? {
      cancellationOrders: 0,
      deliveredOrders: 0,
      label: zoneKey,
      outcomeOrders: 0,
      returnOrders: 0,
      rtoOrders: 0,
      totalOrders: 0,
    };
    nextZone.totalOrders += 1;
    nextZone.cancellationOrders += isCancellation ? 1 : 0;
    nextZone.returnOrders += isReturn ? 1 : 0;
    nextZone.deliveredOrders += isDelivered ? 1 : 0;
    nextZone.rtoOrders += isRto ? 1 : 0;
    nextZone.outcomeOrders += hasOutcome ? 1 : 0;
    zoneAggregates.set(zoneKey, nextZone);

    if (order.assignedDriverId) {
      const driverName = driverNameById.get(order.assignedDriverId) ?? order.assignedDriverId;
      const nextDriver = driverAggregates.get(order.assignedDriverId) ?? {
        deliveredOrders: 0,
        driverId: order.assignedDriverId,
        driverName,
        outcomeOrders: 0,
        returnOrders: 0,
        rtoOrders: 0,
      };
      nextDriver.deliveredOrders += isDelivered ? 1 : 0;
      nextDriver.outcomeOrders += hasOutcome ? 1 : 0;
      nextDriver.returnOrders += isReturn ? 1 : 0;
      nextDriver.rtoOrders += isRto ? 1 : 0;
      driverAggregates.set(order.assignedDriverId, nextDriver);
    }

    if (order.cancelReason) {
      reasonCounts.set(order.cancelReason, (reasonCounts.get(order.cancelReason) ?? 0) + 1);
    }

    for (const line of orderLinesByOrderId.get(order.id) ?? []) {
      const key = `${line.productId ?? 'none'}:${line.rawTitle}:${line.rawSku ?? ''}`;
      const aggregate = productAggregates.get(key) ?? {
        cancellationOrders: 0,
        cancellationUnits: 0,
        deliveredOrders: 0,
        deliveredUnits: 0,
        key,
        name: line.rawTitle,
        outcomeOrders: 0,
        productId: line.productId,
        returnOrders: 0,
        returnUnits: 0,
        rtoOrders: 0,
        rtoUnits: 0,
        sku: line.rawSku,
        totalOrders: 0,
      };
      aggregate.totalOrders += 1;
      aggregate.cancellationOrders += isCancellation ? 1 : 0;
      aggregate.returnOrders += isReturn ? 1 : 0;
      aggregate.deliveredOrders += isDelivered ? 1 : 0;
      aggregate.rtoOrders += isRto ? 1 : 0;
      aggregate.outcomeOrders += hasOutcome ? 1 : 0;
      aggregate.cancellationUnits += isCancellation ? line.qty : 0;
      aggregate.returnUnits += isReturn ? line.qty : 0;
      aggregate.deliveredUnits += isDelivered ? line.qty : 0;
      aggregate.rtoUnits += isRto ? line.qty : 0;
      productAggregates.set(key, aggregate);
    }
  }

  const trends = dayWindow(fromISO, toISO).map((date) => ({
    cancellationCount: 0,
    date,
    deliveredCount: 0,
    returnCount: 0,
    rtoCount: 0,
    rtoDenominator: 0,
    rtoRate: 0,
  }));
  const trendIndex = new Map(trends.map((point, index) => [point.date, index]));

  for (const event of events) {
    const index = trendIndex.get(eventDay(event.createdAt));
    if (index === undefined) {
      continue;
    }

    const point = trends[index];
    if (event.type === 'cancellation') {
      point.cancellationCount += 1;
    }
    if (event.type === 'return') {
      point.returnCount += 1;
    }
    if (event.type === 'rto') {
      point.rtoCount += 1;
      point.rtoDenominator += 1;
    }
    if (event.type === 'delivered_outcome') {
      point.deliveredCount += 1;
      point.rtoDenominator += 1;
    }
  }

  for (const point of trends) {
    point.rtoRate = ratio(point.rtoCount, point.rtoDenominator);
  }

  return {
    driverPerformance: [...driverAggregates.values()]
      .map((driver) => ({
        deliveredOrders: driver.deliveredOrders,
        driverId: driver.driverId,
        driverName: driver.driverName,
        outcomeOrders: driver.outcomeOrders,
        returnOrders: driver.returnOrders,
        returnRate: ratio(driver.returnOrders, driver.deliveredOrders),
        rtoOrders: driver.rtoOrders,
        rtoRate: ratio(driver.rtoOrders, driver.outcomeOrders),
      }))
      .sort(
        (first, second) => second.rtoRate - first.rtoRate || second.rtoOrders - first.rtoOrders,
      ),
    productLosses: [...productAggregates.values()]
      .map((product) => ({
        cancellationOrders: product.cancellationOrders,
        cancellationRate: ratio(product.cancellationOrders, product.totalOrders),
        cancellationUnits: product.cancellationUnits,
        deliveredOrders: product.deliveredOrders,
        deliveredUnits: product.deliveredUnits,
        name: product.name,
        outcomeOrders: product.outcomeOrders,
        productId: product.productId,
        returnOrders: product.returnOrders,
        returnRate: ratio(product.returnOrders, product.deliveredOrders),
        returnUnits: product.returnUnits,
        rtoOrders: product.rtoOrders,
        rtoRate: ratio(product.rtoOrders, product.outcomeOrders),
        rtoUnits: product.rtoUnits,
        sku: product.sku,
        totalOrders: product.totalOrders,
      }))
      .sort(
        (first, second) =>
          second.rtoOrders - first.rtoOrders ||
          second.cancellationOrders - first.cancellationOrders,
      ),
    reasonBreakdown: [...reasonCounts.entries()]
      .map(([reason, count]) => ({ count, reason }))
      .sort(
        (first, second) => second.count - first.count || first.reason.localeCompare(second.reason),
      ),
    repeatedRefusers: reliability
      .filter((customer) => customer.refusedCount >= 2)
      .sort(
        (first, second) => second.refusedCount - first.refusedCount || first.score - second.score,
      )
      .map((customer) => ({
        customerId: customer.customerId,
        fullName: customer.fullName,
        orderCount: customer.orderCount,
        refusedCount: customer.refusedCount,
        score: customer.score,
        tier: customer.tier,
      })),
    sourceScorecard: [...sourceAggregates.entries()]
      .map(([source, summary]) => ({
        cancellationCount: summary.cancellationCount,
        cancellationRate: summary.cancellationRate,
        completionRate: ratio(summary.deliveredCount, summary.rtoDenominator),
        deliveredCount: summary.deliveredCount,
        outcomeOrders: summary.rtoDenominator,
        returnCount: summary.returnCount,
        returnRate: summary.returnRate,
        rtoCount: summary.rtoCount,
        rtoRate: summary.rtoRate,
        source,
        totalOrders: summary.totalOrders,
      }))
      .sort(
        (first, second) =>
          second.totalOrders - first.totalOrders || first.source.localeCompare(second.source),
      ),
    summary: rateSummary(orders.length, cancellationCount, returnCount, deliveredCount, rtoCount),
    trends,
    zoneLosses: [...zoneAggregates.values()]
      .map((zone) => ({
        cancellationOrders: zone.cancellationOrders,
        cancellationRate: ratio(zone.cancellationOrders, zone.totalOrders),
        deliveredOrders: zone.deliveredOrders,
        label: zone.label,
        outcomeOrders: zone.outcomeOrders,
        returnOrders: zone.returnOrders,
        returnRate: ratio(zone.returnOrders, zone.deliveredOrders),
        rtoOrders: zone.rtoOrders,
        rtoRate: ratio(zone.rtoOrders, zone.outcomeOrders),
        totalOrders: zone.totalOrders,
      }))
      .sort(
        (first, second) =>
          second.rtoOrders - first.rtoOrders || second.totalOrders - first.totalOrders,
      ),
  };
}
