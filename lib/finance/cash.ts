export const paymentChannelsAtDelivery = [
  'ESPECES',
  'WAVE',
  'ORANGE_MONEY',
  'FREE_MONEY',
  'INCONNU',
] as const;

export const settlementMethods = ['ESPECES', 'WAVE', 'ORANGE_MONEY', 'FREE_MONEY'] as const;

export type PaymentChannelAtDelivery = (typeof paymentChannelsAtDelivery)[number];
export type SettlementMethod = (typeof settlementMethods)[number];

export type OutstandingOrder = {
  deliveredAt: string;
  orderId: string;
  outstandingMinor: number;
};

export type AllocationResult = {
  allocatedMinor: number;
  allocations: Array<{ allocatedMinor: number; orderId: string }>;
  remainingMinor: number;
};

export function amountToMinor(amount: number): number {
  if (!Number.isFinite(amount)) {
    throw new RangeError('amountToMinor: invalid amount');
  }

  return Math.round(amount);
}

export function cashCollectableMinor({
  cashCollectableMinor: storedMinor,
  paymentChannel,
  totalAmount,
}: {
  cashCollectableMinor?: number | null;
  paymentChannel?: string | null;
  totalAmount: number;
}): number {
  if (storedMinor !== null && storedMinor !== undefined) {
    return storedMinor;
  }

  if (
    paymentChannel === 'WAVE' ||
    paymentChannel === 'ORANGE_MONEY' ||
    paymentChannel === 'FREE_MONEY'
  ) {
    return 0;
  }

  return amountToMinor(totalAmount);
}

export function remainingCashMinor({
  allocatedMinor,
  cashCollectableMinor: collectableMinor,
}: {
  allocatedMinor: number;
  cashCollectableMinor: number;
}): number {
  return Math.max(collectableMinor - allocatedMinor, 0);
}

export function allocateOldestFirst(
  orders: OutstandingOrder[],
  amountReceivedMinor: number,
): AllocationResult {
  let remainingMinor = amountReceivedMinor;
  let allocatedMinor = 0;
  const allocations: AllocationResult['allocations'] = [];

  for (const order of [...orders].sort((left, right) => {
    const byDate = left.deliveredAt.localeCompare(right.deliveredAt);
    return byDate === 0 ? left.orderId.localeCompare(right.orderId) : byDate;
  })) {
    if (remainingMinor <= 0) {
      break;
    }

    const nextAllocation = Math.min(order.outstandingMinor, remainingMinor);

    if (nextAllocation > 0) {
      allocations.push({ orderId: order.orderId, allocatedMinor: nextAllocation });
      allocatedMinor += nextAllocation;
      remainingMinor -= nextAllocation;
    }
  }

  return { allocatedMinor, allocations, remainingMinor };
}

export function agingBucket(deliveredAt: Date, now = new Date()): '1_3d' | 'gt3d' | 'lt1d' {
  const ageDays = (now.getTime() - deliveredAt.getTime()) / 86_400_000;

  if (ageDays < 1) {
    return 'lt1d';
  }

  if (ageDays <= 3) {
    return '1_3d';
  }

  return 'gt3d';
}
