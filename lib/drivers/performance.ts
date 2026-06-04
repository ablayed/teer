import { cashCollectableMinor } from '@/lib/finance/cash';

// Performance par livreur sur une période — dérivée de l'état (cod_status) et
// du cash. « Collecté net des annulations » = somme collectée des commandes
// LIVRÉES uniquement (les annulées/refusées ne contribuent jamais), ce qui est
// par construction net des annulations.

const DELIVERED_STATUS = 'LIVREE';
const CANCELLED_STATUSES = ['ANNULEE', 'REFUSEE'] as const;
const COLLECTED_CASH_STATES = ['collected', 'remitted', 'discrepancy'] as const;

export type PerformanceOrder = {
  codStatus: string | null;
  cashState: string | null;
  cashCollectableMinor: number | null;
  paymentChannel: string | null;
  totalAmount: number;
};

export type DriverPerformance = {
  deliveredCount: number;
  cancelledCount: number;
  decidedCount: number;
  successRate: number; // 0..1
  collectedNetMinor: number;
};

function isCancelled(status: string | null): boolean {
  return (CANCELLED_STATUSES as readonly string[]).includes(status ?? '');
}

function isCollected(cashState: string | null): boolean {
  return (COLLECTED_CASH_STATES as readonly string[]).includes(cashState ?? '');
}

export function deriveDriverPerformance(orders: PerformanceOrder[]): DriverPerformance {
  let deliveredCount = 0;
  let cancelledCount = 0;
  let collectedNetMinor = 0;

  for (const order of orders) {
    if (order.codStatus === DELIVERED_STATUS) {
      deliveredCount += 1;
      if (isCollected(order.cashState)) {
        collectedNetMinor += cashCollectableMinor({
          cashCollectableMinor: order.cashCollectableMinor,
          paymentChannel: order.paymentChannel,
          totalAmount: order.totalAmount,
        });
      }
    } else if (isCancelled(order.codStatus)) {
      cancelledCount += 1;
    }
  }

  const decidedCount = deliveredCount + cancelledCount;

  return {
    deliveredCount,
    cancelledCount,
    decidedCount,
    successRate: decidedCount > 0 ? deliveredCount / decidedCount : 0,
    collectedNetMinor,
  };
}
