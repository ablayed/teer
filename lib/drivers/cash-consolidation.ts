import { cashCollectableMinor } from '@/lib/finance/cash';

// Consolidation cash par livreur — réutilise le modèle dimensionnel (cash_state)
// + les tables cash existantes (settlement_allocation / settlement_shortfall).
// Aucune source de vérité dupliquée : « remis » vient des allocations,
// « écart » des shortfalls non résolus.
//
//   dû / attendu     = Σ cash_collectable des commandes cash_state='expected'
//   collecté         = Σ cash_collectable des commandes cash_state collectées
//   remis            = Σ settlement_allocation (passé en paramètre, pré-sommé)
//   écart            = Σ settlement_shortfall non résolu (ROLLED_FORWARD)
//   cash chez livreur = collecté − remis  (clamp ≥ 0)

// États cash où l'argent est déjà passé physiquement entre les mains du livreur.
const COLLECTED_CASH_STATES = ['collected', 'remitted', 'discrepancy'] as const;

export type ConsolidationOrder = {
  cashState: string | null;
  cashCollectableMinor: number | null;
  paymentChannel: string | null;
  totalAmount: number;
};

export type ConsolidationShortfall = {
  shortfallMinor: number;
  resolution: string;
};

export type DriverCashConsolidation = {
  expectedMinor: number;
  collectedMinor: number;
  remittedMinor: number;
  discrepancyMinor: number;
  cashOnHandMinor: number;
};

function orderCollectable(order: ConsolidationOrder): number {
  return cashCollectableMinor({
    cashCollectableMinor: order.cashCollectableMinor,
    paymentChannel: order.paymentChannel,
    totalAmount: order.totalAmount,
  });
}

export function deriveDriverCashConsolidation({
  orders,
  remittedMinor,
  shortfalls,
}: {
  orders: ConsolidationOrder[];
  remittedMinor: number;
  shortfalls: ConsolidationShortfall[];
}): DriverCashConsolidation {
  let expectedMinor = 0;
  let collectedMinor = 0;

  for (const order of orders) {
    if (order.cashState === 'expected') {
      expectedMinor += orderCollectable(order);
    } else if ((COLLECTED_CASH_STATES as readonly string[]).includes(order.cashState ?? '')) {
      collectedMinor += orderCollectable(order);
    }
  }

  const discrepancyMinor = shortfalls
    .filter((s) => s.resolution === 'ROLLED_FORWARD')
    .reduce((total, s) => total + s.shortfallMinor, 0);

  return {
    expectedMinor,
    collectedMinor,
    remittedMinor,
    discrepancyMinor,
    cashOnHandMinor: Math.max(collectedMinor - remittedMinor, 0),
  };
}
