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

// Carte "Cash chez le livreur (période)" (/livreurs, migration 0100) — même
// clamp que deriveDriverCashConsolidation.cashOnHandMinor, mais appliqué aux
// 3 grandeurs déjà bornées à la période choisie (period_collected_minor,
// period_collected_delivery_fees_minor, period_remitted_minor). Distincte du
// solde live (all-time, jamais périodable — cf. commentaire getDriverCashConsolidation) :
// cette carte est un instantané d'activité sur la fenêtre choisie, pas une
// réconciliation de solde, donc peut légitimement diverger du live.
export function derivePeriodCashOnHand({
  periodCollectedMinor,
  periodCollectedDeliveryFeesMinor,
  periodRemittedMinor,
}: {
  periodCollectedMinor: number;
  periodCollectedDeliveryFeesMinor: number;
  periodRemittedMinor: number;
}): number {
  return Math.max(periodCollectedMinor - periodCollectedDeliveryFeesMinor - periodRemittedMinor, 0);
}

export type DriverConsolidationInput = ConsolidationOrder & {
  driverId: string;
  orderId: string;
};

// Référence de la formule « cash chez le livreur » par livreur — plus appelée directement
// par les surfaces TS depuis les migrations 0083 (page Livreurs, panneau Finances) et 0084
// (rapport PDF), qui la répliquent en SQL via get_driver_cash_consolidation/
// get_driver_cash_outstanding_orders/get_report_driver_cash_pending (parité prouvée en
// tests RLS). Reste la source de vérité pour les tests unitaires de la formule elle-même
// (tests/unit/drivers/cash-consolidation.test.ts) et pour toute future RPC du même domaine.
// Regroupe les commandes assignées par livreur, somme les allocations (remis) par livreur,
// puis applique deriveDriverCashConsolidation — clamp AGRÉGÉ par livreur (collecté − frais −
// remis, greatest 0), JAMAIS un clamp par commande (qui laisse un résidu = frais sur un
// livreur multi-commandes, cf. piège record_cash_settlement oldest-first).
export function consolidateCashByDriver(
  orders: DriverConsolidationInput[],
  allocatedByOrderId: ReadonlyMap<string, number>,
): Map<string, DriverCashConsolidation> {
  const ordersByDriver = new Map<string, DriverConsolidationInput[]>();
  const remittedByDriver = new Map<string, number>();

  for (const order of orders) {
    const list = ordersByDriver.get(order.driverId) ?? [];
    list.push(order);
    ordersByDriver.set(order.driverId, list);

    const remitted = allocatedByOrderId.get(order.orderId) ?? 0;
    if (remitted !== 0) {
      remittedByDriver.set(order.driverId, (remittedByDriver.get(order.driverId) ?? 0) + remitted);
    }
  }

  const result = new Map<string, DriverCashConsolidation>();
  for (const [driverId, driverOrders] of ordersByDriver) {
    result.set(
      driverId,
      deriveDriverCashConsolidation({
        orders: driverOrders,
        remittedMinor: remittedByDriver.get(driverId) ?? 0,
      }),
    );
  }
  return result;
}
