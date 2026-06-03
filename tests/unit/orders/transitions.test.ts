import {
  getAllowedTransitionActions,
  getTransitionActionForTarget,
} from '@/lib/domain/order-transition-actions';
import { describe, expect, it } from 'vitest';

describe('server transition actions', () => {
  it('returns only legal agent actions for the current COD status', () => {
    expect(getAllowedTransitionActions('A_APPELER', 'agent')).toEqual([
      'journaliser_appel',
      'confirmer',
    ]);
    expect(getAllowedTransitionActions('CONFIRMEE', 'agent')).toEqual(['programmer']);
    expect(getAllowedTransitionActions('PROGRAMMEE', 'agent')).toEqual(['assigner']);
    expect(getAllowedTransitionActions('EN_LIVRAISON', 'agent')).toEqual([]);
  });

  it('keeps cash and closure actions for owner and manager roles', () => {
    expect(getAllowedTransitionActions('EN_LIVRAISON', 'owner')).toEqual([
      'livrer',
      'annuler',
      'refuser',
    ]);
    expect(getAllowedTransitionActions('CONFIRMEE', 'manager')).toEqual([
      'programmer',
      'annuler',
      'refuser',
    ]);
  });

  it('maps legacy status targets to authorized actions by role', () => {
    expect(getTransitionActionForTarget('CONFIRMEE', 'agent')).toBe('confirmer');
    expect(getTransitionActionForTarget('LIVREE', 'agent')).toBeNull();
    expect(getTransitionActionForTarget('LIVREE', 'manager')).toBe('livrer');
    expect(getTransitionActionForTarget('ANNULEE', 'owner')).toBe('annuler');
  });
});
