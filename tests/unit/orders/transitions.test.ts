import { transitionInputSchema } from '@/lib/actions/transition-input-schema';
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
    // Lot B : déconfirmer est légale dès qu'une commande ouverte est validée
    // et pré-dispatch (unassigned/scheduled) — agent inclus.
    expect(getAllowedTransitionActions('CONFIRMEE', 'agent')).toEqual([
      'programmer',
      'deconfirmer',
    ]);
    expect(getAllowedTransitionActions('PROGRAMMEE', 'agent')).toEqual(['assigner', 'deconfirmer']);
    expect(getAllowedTransitionActions('EN_LIVRAISON', 'agent')).toEqual([]);
  });

  it('keeps cash and closure actions for owner and manager roles', () => {
    expect(getAllowedTransitionActions('EN_LIVRAISON', 'owner')).toEqual([
      'livrer',
      'annuler',
      'refuser',
    ]);
    expect(getAllowedTransitionActions('LIVREE', 'owner')).toEqual(['mark_returned']);
    expect(getAllowedTransitionActions('LIVREE', 'manager')).toEqual(['mark_returned']);
    expect(getAllowedTransitionActions('LIVREE', 'agent')).toEqual([]);
    expect(getAllowedTransitionActions('CONFIRMEE', 'manager')).toEqual([
      'programmer',
      'annuler',
      'refuser',
      'deconfirmer',
    ]);
  });

  it('maps legacy status targets to authorized actions by role', () => {
    expect(getTransitionActionForTarget('CONFIRMEE', 'agent')).toBe('confirmer');
    expect(getTransitionActionForTarget('LIVREE', 'agent')).toBeNull();
    expect(getTransitionActionForTarget('LIVREE', 'manager')).toBe('livrer');
    expect(getTransitionActionForTarget('REFUSEE', 'owner')).toBe('refuser');
    expect(getTransitionActionForTarget('ANNULEE', 'owner')).toBe('annuler');
    // Lot B : les actions reverse ne sont jamais résolues par target (sinon
    // « A_APPELER » deviendrait actionnable via les chemins inline status).
    expect(getTransitionActionForTarget('A_APPELER', 'owner')).toBeNull();
  });

  describe('Lot B — déconfirmer / désannuler', () => {
    it('expose désannuler comme SEULE action sur une commande annulée (owner/manager)', () => {
      expect(getAllowedTransitionActions('ANNULEE', 'owner')).toEqual(['desannuler']);
      expect(getAllowedTransitionActions('ANNULEE', 'manager')).toEqual(['desannuler']);
    });

    it("n'expose pas désannuler à l'agent ni sur un retour terminal", () => {
      expect(getAllowedTransitionActions('ANNULEE', 'agent')).toEqual([]);
      // REFUSEE = retour terminal (order_state returned/cancelled via failed) :
      // pas de désannuler (seules les annulations se rouvrent).
      expect(getAllowedTransitionActions('REFUSEE', 'owner')).toEqual([]);
    });

    it("n'expose pas déconfirmer une fois la commande dispatchée", () => {
      expect(getAllowedTransitionActions('EN_LIVRAISON', 'owner')).not.toContain('deconfirmer');
      expect(getAllowedTransitionActions('LIVREE', 'owner')).not.toContain('deconfirmer');
    });

    it("valide les raisons d'annulation côté action serveur", () => {
      const orderId = '00000000-0000-4000-8000-000000000001';

      expect(
        transitionInputSchema.safeParse({
          action: 'annuler',
          orderId,
          payload: { cancelReasons: ['prix', 'concurrence', 'refus'] },
        }).success,
      ).toBe(true);

      expect(
        transitionInputSchema.safeParse({
          action: 'annuler',
          orderId,
          payload: {},
        }).success,
      ).toBe(false);

      expect(
        transitionInputSchema.safeParse({
          action: 'annuler',
          orderId,
          payload: { cancelReasons: ['hors_liste'] },
        }).success,
      ).toBe(false);
    });
  });
});
