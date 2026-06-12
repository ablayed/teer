import { allocateFees, totalAllocatedFees } from '@/lib/purchases/fee-allocation';
import { describe, expect, it } from 'vitest';

// Lot C : un seul frais « Transport », prix d'achat saisi en global par ligne
// (purchasePriceTotal = valeur d'achat de la ligne). landedUnitCost divise par qty.

// ── cas de base ───────────────────────────────────────────────────────────────

describe('allocateFees — cas de base', () => {
  it('retourne [] pour un lot sans lignes', () => {
    expect(allocateFees([], 5000)).toEqual([]);
  });

  it('retourne des frais nuls quand le transport est 0', () => {
    const lines = [
      { qty: 5, purchasePriceTotal: 50000 },
      { qty: 3, purchasePriceTotal: 24000 },
    ];
    const result = allocateFees(lines, 0);
    for (const r of result) {
      expect(r.allocatedFees).toBe(0);
      expect(r.landedTotalValue).toBe(r.lineValue);
    }
  });

  it('ligne unique absorbe tout le transport', () => {
    const lines = [{ qty: 4, purchasePriceTotal: 20000 }];
    const transport = 5000;
    const [r] = allocateFees(lines, transport);
    expect(r.allocatedFees).toBe(transport);
    expect(r.landedTotalValue).toBe(r.lineValue + transport);
  });
});

// ── répartition divisible exactement ─────────────────────────────────────────

describe('allocateFees — montant divisible', () => {
  it('répartit proportionnellement sans reste (2 lignes valeur égale)', () => {
    const lines = [
      { qty: 2, purchasePriceTotal: 10000 },
      { qty: 2, purchasePriceTotal: 10000 },
    ];
    const [r0, r1] = allocateFees(lines, 2000);
    expect(r0.allocatedFees).toBe(1000);
    expect(r1.allocatedFees).toBe(1000);
    expect(r0.allocatedFees + r1.allocatedFees).toBe(2000);
  });

  it('répartit au prorata de la valeur (2 lignes valeur 2:1)', () => {
    // v0 = 2000, v1 = 1000, V = 3000, transport = 3000 → r0 = 2000, r1 = 1000
    const lines = [
      { qty: 2, purchasePriceTotal: 2000 },
      { qty: 1, purchasePriceTotal: 1000 },
    ];
    const [r0, r1] = allocateFees(lines, 3000);
    expect(r0.allocatedFees).toBe(2000);
    expect(r1.allocatedFees).toBe(1000);
  });
});

// ── plus grand reste (montant non divisible) ──────────────────────────────────

describe('allocateFees — plus grand reste', () => {
  it('transport 1 499, 3 lignes de valeur égale → somme exacte 1 499', () => {
    const lines = [
      { qty: 1, purchasePriceTotal: 500 },
      { qty: 1, purchasePriceTotal: 500 },
      { qty: 1, purchasePriceTotal: 500 },
    ];
    const result = allocateFees(lines, 1499);
    expect(result[0].allocatedFees).toBe(500);
    expect(result[1].allocatedFees).toBe(500);
    expect(result[2].allocatedFees).toBe(499);
    expect(totalAllocatedFees(result)).toBe(1499);
  });

  it('transport 1 499, valeurs 2:1 → le plus grand reste reçoit le franc restant', () => {
    // v0=1000, v1=500, V=1500
    // floor_0=999 reste_0=500 ; floor_1=499 reste_1=1000 → leftover 1 va à la ligne 1
    const lines = [
      { qty: 2, purchasePriceTotal: 1000 },
      { qty: 1, purchasePriceTotal: 500 },
    ];
    const [r0, r1] = allocateFees(lines, 1499);
    expect(r0.allocatedFees).toBe(999);
    expect(r1.allocatedFees).toBe(500);
    expect(r0.allocatedFees + r1.allocatedFees).toBe(1499);
  });

  it('invariant somme — 5 lignes, transport non divisible', () => {
    const lines = [
      { qty: 3, purchasePriceTotal: 21000 },
      { qty: 1, purchasePriceTotal: 12000 },
      { qty: 5, purchasePriceTotal: 22500 },
      { qty: 2, purchasePriceTotal: 18600 },
      { qty: 4, purchasePriceTotal: 24400 },
    ];
    const transport = 17777 + 8321 + 4003 + 2999;
    const result = allocateFees(lines, transport);
    expect(totalAllocatedFees(result)).toBe(transport);
  });
});

// ── cas limites ────────────────────────────────────────────────────────────────

describe('allocateFees — cas limites', () => {
  it('V = 0 (toutes les valeurs nulles) → répartition égale, somme exacte', () => {
    const lines = [
      { qty: 0, purchasePriceTotal: 0 },
      { qty: 0, purchasePriceTotal: 0 },
      { qty: 0, purchasePriceTotal: 0 },
    ];
    const result = allocateFees(lines, 100);
    expect(totalAllocatedFees(result)).toBe(100);
  });

  it('ligne sans valeur dans un lot mixte → elle reçoit 0 franc de transport', () => {
    const lines = [
      { qty: 0, purchasePriceTotal: 0 },
      { qty: 5, purchasePriceTotal: 20000 },
    ];
    const [r0, r1] = allocateFees(lines, 5000);
    expect(r0.allocatedFees).toBe(0);
    expect(r1.allocatedFees).toBe(5000);
  });

  it('ligne qty=0 → landedUnitCost = 0 (pas de division par zéro)', () => {
    const lines = [{ qty: 0, purchasePriceTotal: 0 }];
    const [r] = allocateFees(lines, 0);
    expect(r.landedUnitCost).toBe(0);
  });

  it('coût unitaire atterri = floor(landedTotalValue / qty)', () => {
    // lineValue 27 000 + transport 1 000 = 28 000 ; floor(28000/3) = 9 333
    const lines = [{ qty: 3, purchasePriceTotal: 27000 }];
    const [r] = allocateFees(lines, 1000);
    expect(r.landedTotalValue).toBe(28000);
    expect(r.landedUnitCost).toBe(Math.floor(28000 / 3));
  });

  it('landedTotalValue = lineValue + allocatedFees (invariant)', () => {
    const lines = [
      { qty: 10, purchasePriceTotal: 30000 },
      { qty: 7, purchasePriceTotal: 35000 },
    ];
    const transport = 12345 + 6789 + 1001 + 555;
    const result = allocateFees(lines, transport);
    for (const r of result) {
      expect(r.landedTotalValue).toBe(r.lineValue + r.allocatedFees);
    }
  });
});
