import { cashCollectableMinor } from '@/lib/finance/cash';

// Consolidation cash par livreur - réutilise le modèle dimensionnel (cash_state)
// + les allocations de versement existantes. Aucune source de vérité dupliquée :
// « remis » vient des allocations, « écart » est DÉRIVÉ du live (jamais d'une
// ligne settlement_shortfall figée).
//
//   dû / attendu      = Σ cash_collectable des commandes cash_state='expected'
//   collecté          = Σ cash_collectable des commandes cash_state collectées
//   frais livraison   = Σ delivery_fee_minor des commandes assignées au livreur
//                      (prévisionnel) ; la déduction du cash à remettre utilise
//                      uniquement les commandes réellement encaissées.
//   remis             = Σ settlement_allocation (passé en paramètre, pré-sommé)
//   cash chez livreur = collecté − frais encaissés − remis  (clamp ≥ 0)
//   écart non résolu  = collecté − remis  — recalculé en direct : une remise du
//                       solde le ramène à zéro, et un write-off (qui crée des
//                       allocations compensatoires) aussi. Lire la ligne
//                       settlement_shortfall figée laissait l'écart bloqué après
//                       une remise partielle puis complétée.

// États cash où l'argent est déjà passé physiquement entre les mains du livreur.
const COLLECTED_CASH_STATES = ['collected', 'remitted', 'discrepancy'] as const;

export type ConsolidationOrder = {
  deliveryFeeMinor: number | null;
  cashState: string | null;
  cashCollectableMinor: number | null;
  paymentChannel: string | null;
  totalAmount: number;
};

export type DriverCashConsolidation = {
  expectedMinor: number;
  collectedMinor: number;
  deliveryFeesMinor: number;
  collectedDeliveryFeesMinor: number;
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
}: {
  orders: ConsolidationOrder[];
  remittedMinor: number;
}): DriverCashConsolidation {
  let expectedMinor = 0;
  let collectedMinor = 0;
  let deliveryFeesMinor = 0;
  let collectedDeliveryFeesMinor = 0;

  for (const order of orders) {
    deliveryFeesMinor += order.deliveryFeeMinor ?? 0;

    if (order.cashState === 'expected') {
      expectedMinor += orderCollectable(order);
    } else if ((COLLECTED_CASH_STATES as readonly string[]).includes(order.cashState ?? '')) {
      collectedMinor += orderCollectable(order);
      collectedDeliveryFeesMinor += order.deliveryFeeMinor ?? 0;
    }
  }

  // Solde non remis, recalculé en direct (jamais une ligne settlement_shortfall
  // figée) : l'écart n'existe que tant que collecté − frais − remis ≠ 0.
  const cashOnHandMinor = Math.max(collectedMinor - collectedDeliveryFeesMinor - remittedMinor, 0);

  return {
    expectedMinor,
    collectedMinor,
    deliveryFeesMinor,
    collectedDeliveryFeesMinor,
    remittedMinor,
    discrepancyMinor: cashOnHandMinor,
    cashOnHandMinor,
  };
}
