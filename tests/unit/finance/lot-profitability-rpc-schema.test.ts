import { purchaseLotProfitabilityRpcResultSchema } from '@/lib/finance/lot-profitability-assembly';
import { describe, expect, it } from 'vitest';

// La RPC get_purchase_lot_profitability déclare `returns jsonb` (0146) :
// database.types.ts la type donc en `Json` générique, jamais en la forme
// réelle. Ce schéma est le seul rempart contre une divergence silencieuse
// entre la RPC et le TS qui la consomme (lib/actions/purchases.ts) — un
// parse raté doit échouer franchement, en nommant le champ fautif, jamais
// laisser passer une valeur qui affichera n'importe quoi à l'écran.
describe('purchaseLotProfitabilityRpcResultSchema — parse à la frontière', () => {
  const validPayload = {
    purchaseLotId: 'lot-1',
    transportTotalMinor: 0,
    transportComplete: true,
    allocationMethod: 'value',
    lines: [
      {
        purchaseLotLineId: 'line-1',
        productId: 'p1',
        qtyReceived: 20,
        qtySold: 19,
        purchaseValueMinor: 265_200,
        weightGrams: 5_000,
        cashCollectedMinor: 408_000,
      },
    ],
    productAdSpend: [{ productId: 'p1', amountMinor: 66_700 }],
  };

  it('accepte la forme réelle rendue par la RPC (0146)', () => {
    const result = purchaseLotProfitabilityRpcResultSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it('refuse une forme inattendue et nomme le champ fautif', () => {
    // qtyReceived rendu en chaîne au lieu d'un nombre — simule une RPC dont la
    // forme a divergé du contrat attendu ici.
    const malformed = {
      ...validPayload,
      lines: [{ ...validPayload.lines[0], qtyReceived: '20' }],
    };

    const result = purchaseLotProfitabilityRpcResultSchema.safeParse(malformed);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');

    const faultyPath = result.error.issues[0]?.path.join('.');
    expect(faultyPath).toBe('lines.0.qtyReceived');
  });

  it('refuse une allocationMethod hors énumération', () => {
    const malformed = { ...validPayload, allocationMethod: 'volume' };
    const result = purchaseLotProfitabilityRpcResultSchema.safeParse(malformed);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.issues.some((issue) => issue.path.join('.') === 'allocationMethod')).toBe(
      true,
    );
  });

  it('refuse un champ racine manquant (transportComplete)', () => {
    const { transportComplete: _transportComplete, ...malformed } = validPayload;
    const result = purchaseLotProfitabilityRpcResultSchema.safeParse(malformed);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.issues.some((issue) => issue.path.join('.') === 'transportComplete')).toBe(
      true,
    );
  });
});
