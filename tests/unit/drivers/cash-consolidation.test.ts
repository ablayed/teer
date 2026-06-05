import {
  type ConsolidationOrder,
  deriveDriverCashConsolidation,
} from '@/lib/drivers/cash-consolidation';
import { describe, expect, it } from 'vitest';

function order(partial: Partial<ConsolidationOrder>): ConsolidationOrder {
  return {
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
        order({ cashState: 'collected', cashCollectableMinor: 5000 }),
        order({ cashState: 'collected', cashCollectableMinor: 3000 }),
      ],
      remittedMinor: 6000,
    });
    expect(result.collectedMinor).toBe(8000);
    expect(result.remittedMinor).toBe(6000);
    expect(result.cashOnHandMinor).toBe(2000);
  });

  it('sépare dû (expected) et collecté', () => {
    const result = deriveDriverCashConsolidation({
      orders: [
        order({ cashState: 'expected', cashCollectableMinor: 2000 }),
        order({ cashState: 'collected', cashCollectableMinor: 4000 }),
      ],
      remittedMinor: 0,
    });
    expect(result.expectedMinor).toBe(2000);
    expect(result.collectedMinor).toBe(4000);
  });

  it('remitted et discrepancy comptent comme collecté', () => {
    const result = deriveDriverCashConsolidation({
      orders: [
        order({ cashState: 'remitted', cashCollectableMinor: 1000 }),
        order({ cashState: 'discrepancy', cashCollectableMinor: 500 }),
      ],
      remittedMinor: 0,
    });
    expect(result.collectedMinor).toBe(1500);
  });

  it('cash en main clampé à 0 si remis > collecté', () => {
    const result = deriveDriverCashConsolidation({
      orders: [order({ cashState: 'collected', cashCollectableMinor: 1000 })],
      remittedMinor: 5000,
    });
    expect(result.cashOnHandMinor).toBe(0);
  });

  it('écart = solde non remis (collecté − remis), affiché après remise partielle', () => {
    const result = deriveDriverCashConsolidation({
      orders: [order({ cashState: 'collected', cashCollectableMinor: 100000 })],
      remittedMinor: 50000,
    });
    expect(result.discrepancyMinor).toBe(50000);
  });

  it('écart à zéro une fois le solde entièrement remis', () => {
    const result = deriveDriverCashConsolidation({
      orders: [order({ cashState: 'collected', cashCollectableMinor: 100000 })],
      remittedMinor: 100000,
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
});
