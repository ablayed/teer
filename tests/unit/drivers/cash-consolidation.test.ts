import {
  type ConsolidationOrder,
  type DriverConsolidationInput,
  consolidateCashByDriver,
  deriveDriverCashConsolidation,
  derivePeriodCashOnHand,
} from '@/lib/drivers/cash-consolidation';
import { describe, expect, it } from 'vitest';

// Carte "Cash chez le livreur (période)" (/livreurs, migration 0100) — même clamp que
// deriveDriverCashConsolidation.cashOnHandMinor, appliqué aux 3 grandeurs bornées à la
// période (period_collected_minor/period_collected_delivery_fees_minor/period_remitted_minor).
describe('derivePeriodCashOnHand', () => {
  it('collecté − frais − remis, tous bornés à la période', () => {
    expect(
      derivePeriodCashOnHand({
        periodCollectedMinor: 8000,
        periodCollectedDeliveryFeesMinor: 500,
        periodRemittedMinor: 3000,
      }),
    ).toBe(4500);
  });

  it('clampé à 0 si remis (période) > collecté (période) − frais (période)', () => {
    expect(
      derivePeriodCashOnHand({
        periodCollectedMinor: 1000,
        periodCollectedDeliveryFeesMinor: 100,
        periodRemittedMinor: 5000,
      }),
    ).toBe(0);
  });

  it('zéro collecte sur la période, un versement couvrant des commandes hors période → clampé à 0, pas négatif', () => {
    // Cas typique de divergence légitime avec la carte live : un versement peut couvrir des
    // commandes collectées AVANT la période sélectionnée (period_remitted_minor > 0 sans
    // period_collected_minor correspondant).
    expect(
      derivePeriodCashOnHand({
        periodCollectedMinor: 0,
        periodCollectedDeliveryFeesMinor: 0,
        periodRemittedMinor: 2000,
      }),
    ).toBe(0);
  });

  it('aucune activité sur la période → 0', () => {
    expect(
      derivePeriodCashOnHand({
        periodCollectedMinor: 0,
        periodCollectedDeliveryFeesMinor: 0,
        periodRemittedMinor: 0,
      }),
    ).toBe(0);
  });
});

// Réplique PURE de l'arithmétique SQL finance_kpis.outstanding_by_driver (migration 0065) :
// collecté (cash_state ∈ {collected,remitted,discrepancy}) − frais − remis (Σ allocations du
// livreur), greatest(…, 0), AGRÉGÉ par livreur. Sert à prouver — sur le même jeu de données —
// que la FORMULE de la card Finances (SQL) == le helper TS == la référence Livreurs. La vraie
// fonction SQL est vérifiée à part en RLS (tests/rls/finance-driver-cash.rls.test.ts).
const COLLECTED = new Set(['collected', 'remitted', 'discrepancy']);
function financeKpisCashChezLivreurs(
  orders: DriverConsolidationInput[],
  allocatedByOrderId: Map<string, number>,
): number {
  const collectedByDriver = new Map<string, { collected: number; fees: number }>();
  const remittedByDriver = new Map<string, number>();
  for (const o of orders) {
    const remitted = allocatedByOrderId.get(o.orderId) ?? 0;
    if (remitted !== 0) {
      remittedByDriver.set(o.driverId, (remittedByDriver.get(o.driverId) ?? 0) + remitted);
    }
    if (!COLLECTED.has(o.cashState ?? '')) {
      continue;
    }
    const collectable =
      o.cashCollectableMinor ??
      (o.paymentChannel === 'WAVE' ||
      o.paymentChannel === 'ORANGE_MONEY' ||
      o.paymentChannel === 'FREE_MONEY'
        ? 0
        : Math.round(o.totalAmount));
    const agg = collectedByDriver.get(o.driverId) ?? { collected: 0, fees: 0 };
    agg.collected += collectable;
    agg.fees += o.deliveryFeeMinor ?? 0;
    collectedByDriver.set(o.driverId, agg);
  }
  let total = 0;
  for (const [driverId, agg] of collectedByDriver) {
    total += Math.max(agg.collected - agg.fees - (remittedByDriver.get(driverId) ?? 0), 0);
  }
  return total;
}

function totalCashOnHand(consolidations: ReturnType<typeof consolidateCashByDriver>): number {
  let total = 0;
  for (const c of consolidations.values()) {
    total += c.cashOnHandMinor;
  }
  return total;
}

function order(partial: Partial<ConsolidationOrder>): ConsolidationOrder {
  return {
    deliveryFeeMinor: 0,
    cashState: 'collected',
    cashCollectableMinor: 1000,
    paymentChannel: 'ESPECES',
    totalAmount: 1000,
    ...partial,
  };
}

describe('deriveDriverCashConsolidation', () => {
  it('cash chez le livreur = collecté − remis', () => {
    const result = deriveDriverCashConsolidation({
      orders: [
        order({ cashState: 'collected', cashCollectableMinor: 5000, deliveryFeeMinor: 200 }),
        order({ cashState: 'collected', cashCollectableMinor: 3000, deliveryFeeMinor: 300 }),
      ],
      remittedMinor: 6000,
    });
    expect(result.collectedMinor).toBe(8000);
    expect(result.deliveryFeesMinor).toBe(500);
    expect(result.collectedDeliveryFeesMinor).toBe(500);
    expect(result.remittedMinor).toBe(6000);
    expect(result.cashOnHandMinor).toBe(1500);
  });

  it('sépare dû (expected) et collecté', () => {
    const result = deriveDriverCashConsolidation({
      orders: [
        order({ cashState: 'expected', cashCollectableMinor: 2000, deliveryFeeMinor: 100 }),
        order({ cashState: 'collected', cashCollectableMinor: 4000, deliveryFeeMinor: 400 }),
      ],
      remittedMinor: 0,
    });
    expect(result.expectedMinor).toBe(2000);
    expect(result.collectedMinor).toBe(4000);
    expect(result.deliveryFeesMinor).toBe(500);
    expect(result.collectedDeliveryFeesMinor).toBe(400);
  });

  it('remitted et discrepancy comptent comme collecté', () => {
    const result = deriveDriverCashConsolidation({
      orders: [
        order({ cashState: 'remitted', cashCollectableMinor: 1000, deliveryFeeMinor: 150 }),
        order({ cashState: 'discrepancy', cashCollectableMinor: 500, deliveryFeeMinor: 50 }),
      ],
      remittedMinor: 0,
    });
    expect(result.collectedMinor).toBe(1500);
    expect(result.collectedDeliveryFeesMinor).toBe(200);
  });

  it('cash en main clampé à 0 si remis > collecté', () => {
    const result = deriveDriverCashConsolidation({
      orders: [
        order({ cashState: 'collected', cashCollectableMinor: 1000, deliveryFeeMinor: 100 }),
      ],
      remittedMinor: 5000,
    });
    expect(result.cashOnHandMinor).toBe(0);
  });

  it('écart = solde non remis (collecté − remis), affiché après remise partielle', () => {
    const result = deriveDriverCashConsolidation({
      orders: [
        order({ cashState: 'collected', cashCollectableMinor: 100000, deliveryFeeMinor: 5000 }),
      ],
      remittedMinor: 50000,
    });
    expect(result.discrepancyMinor).toBe(45000);
  });

  it('écart à zéro une fois le solde entièrement remis', () => {
    const result = deriveDriverCashConsolidation({
      orders: [
        order({ cashState: 'collected', cashCollectableMinor: 100000, deliveryFeeMinor: 5000 }),
      ],
      remittedMinor: 95000,
    });
    expect(result.discrepancyMinor).toBe(0);
  });

  it('mobile money: cash_collectable 0 → pas de cash attendu', () => {
    const result = deriveDriverCashConsolidation({
      orders: [order({ cashState: 'collected', cashCollectableMinor: 0, paymentChannel: 'WAVE' })],
      remittedMinor: 0,
    });
    expect(result.collectedMinor).toBe(0);
  });

  it('frais de livraison forecast inclut les commandes assignées, mais la remise ne compte que les encaissées', () => {
    const result = deriveDriverCashConsolidation({
      orders: [
        order({ cashState: 'expected', cashCollectableMinor: 2000, deliveryFeeMinor: 300 }),
        order({ cashState: 'collected', cashCollectableMinor: 4000, deliveryFeeMinor: 700 }),
      ],
      remittedMinor: 1000,
    });

    expect(result.deliveryFeesMinor).toBe(1000);
    expect(result.collectedDeliveryFeesMinor).toBe(700);
    expect(result.cashOnHandMinor).toBe(2300);
  });
});

function input(partial: Partial<DriverConsolidationInput>): DriverConsolidationInput {
  return {
    driverId: 'd1',
    orderId: 'o1',
    deliveryFeeMinor: 0,
    cashState: 'collected',
    cashCollectableMinor: 1000,
    paymentChannel: 'ESPECES',
    totalAmount: 1000,
    ...partial,
  };
}

// Verrou anti-divergence : sur le MÊME jeu de données, les 3 surfaces « cash chez le livreur »
// doivent renvoyer le MÊME chiffre — page Livreurs (deriveDriverCashConsolidation), card Finances
// (réplique de finance_kpis SQL, migration 0065) et builder PDF/panneau (consolidateCashByDriver).
// Empêche une 4ᵉ surface de re-diverger.
describe('cash chez le livreur — égalité des surfaces (C1)', () => {
  function assertAllAgree(
    orders: DriverConsolidationInput[],
    allocatedByOrderId: Map<string, number>,
    expected: number,
  ) {
    const helperTotal = totalCashOnHand(consolidateCashByDriver(orders, allocatedByOrderId));
    const sqlReplica = financeKpisCashChezLivreurs(orders, allocatedByOrderId);

    // Référence Livreurs, par livreur (deriveDriverCashConsolidation prend un seul livreur).
    const byDriver = new Map<string, DriverConsolidationInput[]>();
    const remittedByDriver = new Map<string, number>();
    for (const o of orders) {
      byDriver.set(o.driverId, [...(byDriver.get(o.driverId) ?? []), o]);
      const r = allocatedByOrderId.get(o.orderId) ?? 0;
      if (r) remittedByDriver.set(o.driverId, (remittedByDriver.get(o.driverId) ?? 0) + r);
    }
    let referenceTotal = 0;
    for (const [driverId, driverOrders] of byDriver) {
      referenceTotal += deriveDriverCashConsolidation({
        orders: driverOrders,
        remittedMinor: remittedByDriver.get(driverId) ?? 0,
      }).cashOnHandMinor;
    }

    expect(helperTotal).toBe(expected);
    expect(sqlReplica).toBe(expected);
    expect(referenceTotal).toBe(expected);
  }

  it('le cas qui a buggé : frais=1000 + versement complet → 0 (pas de résidu de frais)', () => {
    // Client paie 5000, livreur garde 1000 de frais, doit donc remettre 4000, et le fait.
    const orders = [
      input({
        orderId: 'o1',
        cashCollectableMinor: 5000,
        deliveryFeeMinor: 1000,
        totalAmount: 5000,
      }),
    ];
    const allocations = new Map([['o1', 4000]]);
    assertAllAgree(orders, allocations, 0);
  });

  it('piège multi-commandes : oldest-first sature la 1re commande → 0, jamais un fantôme', () => {
    // A(5000, frais 1000) + B(3000, frais 500). Net dû = 4000 + 2500 = 6500, remis 6500.
    // record_cash_settlement (capé au BRUT, oldest-first) alloue A:5000, B:1500.
    // Un clamp PAR COMMANDE donnerait A:0 + B:max(3000−500−1500,0)=1000 → 1000 fantôme.
    // L'agrégat par livreur donne 0. Les 3 surfaces doivent donner 0.
    const orders = [
      input({
        orderId: 'a',
        cashCollectableMinor: 5000,
        deliveryFeeMinor: 1000,
        totalAmount: 5000,
      }),
      input({ orderId: 'b', cashCollectableMinor: 3000, deliveryFeeMinor: 500, totalAmount: 3000 }),
    ];
    const allocations = new Map([
      ['a', 5000],
      ['b', 1500],
    ]);
    assertAllAgree(orders, allocations, 0);

    // Garde-fou : le clamp NAÏF par commande aurait bien produit le fantôme de 1000.
    const naivePerOrder = orders.reduce(
      (sum, o) =>
        sum +
        Math.max(
          (o.cashCollectableMinor ?? 0) -
            (o.deliveryFeeMinor ?? 0) -
            (allocations.get(o.orderId) ?? 0),
          0,
        ),
      0,
    );
    expect(naivePerOrder).toBe(1000);
  });

  it('remise partielle : reste à remettre = net non encore remis, identique sur les 3 surfaces', () => {
    // Collecté 10000, frais 1000 → net dû 9000 ; remis 6000 → reste 3000.
    const orders = [
      input({
        orderId: 'o1',
        cashCollectableMinor: 10000,
        deliveryFeeMinor: 1000,
        totalAmount: 10000,
      }),
    ];
    assertAllAgree(orders, new Map([['o1', 6000]]), 3000);
  });

  it('plusieurs livreurs + commande livrée non encaissée (expected) exclue', () => {
    const orders = [
      // Livreur d1 : encaissé, net dû 4000, remis 4000 → 0.
      input({ driverId: 'd1', orderId: 'd1a', cashCollectableMinor: 5000, deliveryFeeMinor: 1000 }),
      // Livreur d2 : encaissé, net dû 2500, remis 0 → 2500.
      input({ driverId: 'd2', orderId: 'd2a', cashCollectableMinor: 3000, deliveryFeeMinor: 500 }),
      // Livreur d2 : livrée mais cash pas encore encaissé (expected) → 0 dans cashOnHand.
      input({
        driverId: 'd2',
        orderId: 'd2b',
        cashState: 'expected',
        cashCollectableMinor: 9999,
        deliveryFeeMinor: 999,
      }),
    ];
    assertAllAgree(orders, new Map([['d1a', 4000]]), 2500);
  });
});
