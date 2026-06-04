import { type PerformanceOrder, deriveDriverPerformance } from '@/lib/drivers/performance';
import { describe, expect, it } from 'vitest';

function order(partial: Partial<PerformanceOrder>): PerformanceOrder {
  return {
    codStatus: 'LIVREE',
    cashState: 'collected',
    cashCollectableMinor: 1000,
    paymentChannel: 'ESPECES',
    totalAmount: 1000,
    ...partial,
  };
}

describe('deriveDriverPerformance', () => {
  it('compte livrées vs annulées/refusées et le taux de succès', () => {
    const perf = deriveDriverPerformance([
      order({ codStatus: 'LIVREE' }),
      order({ codStatus: 'LIVREE' }),
      order({ codStatus: 'LIVREE' }),
      order({ codStatus: 'ANNULEE' }),
      order({ codStatus: 'REFUSEE' }),
    ]);
    expect(perf.deliveredCount).toBe(3);
    expect(perf.cancelledCount).toBe(2);
    expect(perf.decidedCount).toBe(5);
    expect(perf.successRate).toBeCloseTo(0.6, 5);
  });

  it('collecté net des annulations: seules les livrées collectées comptent', () => {
    const perf = deriveDriverPerformance([
      order({ codStatus: 'LIVREE', cashState: 'collected', cashCollectableMinor: 4000 }),
      order({ codStatus: 'ANNULEE', cashState: 'not_due', cashCollectableMinor: 9999 }),
      order({ codStatus: 'LIVREE', cashState: 'expected', cashCollectableMinor: 3000 }),
    ]);
    // l'annulée n'ajoute rien ; la livrée non collectée (expected) non plus
    expect(perf.collectedNetMinor).toBe(4000);
  });

  it('taux de succès 0 si aucune commande décidée', () => {
    const perf = deriveDriverPerformance([order({ codStatus: 'A_APPELER' })]);
    expect(perf.decidedCount).toBe(0);
    expect(perf.successRate).toBe(0);
  });
});
