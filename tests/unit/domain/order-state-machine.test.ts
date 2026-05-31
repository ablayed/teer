import {
  IllegalTransitionError,
  type OrderStatus,
  assertTransition,
  canTransition,
  getAllowedTransitions,
  isTerminal,
  orderStatusLabels,
  orderStatuses,
} from '@/lib/domain/order-state-machine';
import { describe, expect, it } from 'vitest';

const expectedTransitions: Record<OrderStatus, OrderStatus[]> = {
  A_APPELER: ['TENTEE', 'CONFIRMEE', 'REFUSEE', 'ANNULEE'],
  TENTEE: ['TENTEE', 'CONFIRMEE', 'REFUSEE', 'ANNULEE', 'A_APPELER'],
  CONFIRMEE: ['PROGRAMMEE', 'ANNULEE', 'REFUSEE'],
  PROGRAMMEE: ['EN_LIVRAISON', 'ANNULEE', 'REFUSEE'],
  EN_LIVRAISON: ['LIVREE', 'REFUSEE', 'ANNULEE'],
  LIVREE: [],
  REFUSEE: [],
  ANNULEE: [],
};

describe('COD order state machine', () => {
  it('evaluates every legal and illegal status pair', () => {
    for (const from of orderStatuses) {
      for (const to of orderStatuses) {
        const expected = expectedTransitions[from].includes(to);

        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it('allows legal transitions without throwing', () => {
    for (const from of orderStatuses) {
      for (const to of expectedTransitions[from]) {
        expect(() => assertTransition(from, to), `${from} -> ${to}`).not.toThrow();
      }
    }
  });

  it('throws a typed French error for illegal transitions', () => {
    for (const from of orderStatuses) {
      for (const to of orderStatuses) {
        if (expectedTransitions[from].includes(to)) {
          continue;
        }

        expect(() => assertTransition(from, to), `${from} -> ${to}`).toThrow(
          IllegalTransitionError,
        );
        expect(() => assertTransition(from, to), `${from} -> ${to}`).toThrow(
          `Transition COD impossible : ${orderStatusLabels[from]} vers ${orderStatusLabels[to]}.`,
        );
      }
    }
  });

  it('returns exactly the allowed transitions for every status', () => {
    for (const from of orderStatuses) {
      expect(getAllowedTransitions(from)).toEqual(expectedTransitions[from]);
    }
  });

  it('identifies terminal statuses', () => {
    expect(isTerminal('LIVREE')).toBe(true);
    expect(isTerminal('REFUSEE')).toBe(true);
    expect(isTerminal('ANNULEE')).toBe(true);

    expect(isTerminal('A_APPELER')).toBe(false);
    expect(isTerminal('TENTEE')).toBe(false);
    expect(isTerminal('CONFIRMEE')).toBe(false);
    expect(isTerminal('PROGRAMMEE')).toBe(false);
    expect(isTerminal('EN_LIVRAISON')).toBe(false);
  });
});
