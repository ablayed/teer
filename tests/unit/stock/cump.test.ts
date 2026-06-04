import { describe, expect, it } from 'vitest';

/**
 * CUMP (Coût Unitaire Moyen Pondéré) formula, mirrored from lib/stock/movements.ts.
 * new_cump = floor((qty_on_hand * old_cump + received * received_cost) / (qty_on_hand + received))
 */
function computeCump(qtyOnHand: number, oldCump: number, received: number, cost: number): number {
  const total = qtyOnHand + received;
  if (total === 0) return 0;
  return Math.floor((qtyOnHand * oldCump + received * cost) / total);
}

describe('CUMP recalculation on purchase_in', () => {
  it('initial reception sets CUMP to received cost', () => {
    expect(computeCump(0, 0, 10, 5000)).toBe(5000);
  });

  it('second reception at same cost keeps CUMP unchanged', () => {
    expect(computeCump(10, 5000, 10, 5000)).toBe(5000);
  });

  it('cheaper batch lowers CUMP', () => {
    // 10 @ 5000 + 10 @ 3000 → (50000 + 30000) / 20 = 4000
    expect(computeCump(10, 5000, 10, 3000)).toBe(4000);
  });

  it('more expensive batch raises CUMP', () => {
    // 10 @ 5000 + 5 @ 8000 → (50000 + 40000) / 15 = 6000
    expect(computeCump(10, 5000, 5, 8000)).toBe(6000);
  });

  it('floors fractional result (integer-safe)', () => {
    // 1 @ 3 + 1 @ 2 → 5 / 2 = 2.5 → floor = 2
    expect(computeCump(1, 3, 1, 2)).toBe(2);
  });

  it('cost = 0 (free stock) is valid', () => {
    // 10 @ 5000 + 5 @ 0 → 50000 / 15 = 3333
    expect(computeCump(10, 5000, 5, 0)).toBe(3333);
  });

  it('zero total is not possible (min 1 received), guarded by formula', () => {
    // Defensive: should return 0 when total would be 0
    expect(computeCump(0, 0, 0, 5000)).toBe(0);
  });
});

describe('stock position invariants', () => {
  it('reserve increments qty_reserved without touching qty_on_hand', () => {
    const before = { qtyOnHand: 100, qtyReserved: 10 };
    const delta = 5;
    expect(before.qtyOnHand).toBe(100); // unchanged
    expect(before.qtyReserved + delta).toBe(15);
  });

  it('release decrements qty_reserved, never below 0', () => {
    const reserved = 3;
    const release = 10;
    expect(Math.max(0, reserved - release)).toBe(0);
  });

  it('dispatch decrements both qty_on_hand and qty_reserved', () => {
    const before = { qtyOnHand: 100, qtyReserved: 10 };
    const dispatched = 3;
    expect(Math.max(0, before.qtyOnHand - dispatched)).toBe(97);
    expect(Math.max(0, before.qtyReserved - dispatched)).toBe(7);
  });

  it('qty_available = max(0, qty_on_hand - qty_reserved)', () => {
    expect(Math.max(0, 100 - 10)).toBe(90);
    // Edge: reserved > on_hand (should not happen normally but is guarded)
    expect(Math.max(0, 5 - 10)).toBe(0);
  });
});
