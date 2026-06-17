import { transitionInputSchema } from '@/lib/actions/transition-input-schema';
import {
  buildTransitionDimensionPatch,
  getAllowedTransitionActions,
  getAllowedTransitionActionsForDimensions,
  getTransitionActionForTarget,
  legacyStatusToDimensions,
  visibleAllowedActions,
} from '@/lib/domain/order-transition-actions';
import { describe, expect, it } from 'vitest';

describe('server transition actions', () => {
  it('returns only legal agent actions for the current COD status', () => {
    // Phase 11 : « programmer » est désormais légale dès « À appeler » (confirm
    // + programmation fusionnés). « confirmer » reste au niveau moteur.
    expect(getAllowedTransitionActions('A_APPELER', 'agent')).toEqual([
      'journaliser_appel',
      'confirmer',
      'programmer',
    ]);
    // Lot B : déconfirmer est légale dès qu'une commande ouverte est validée
    // et pré-dispatch (unassigned/scheduled) — agent inclus.
    expect(getAllowedTransitionActions('CONFIRMEE', 'agent')).toEqual([
      'programmer',
      'deconfirmer',
    ]);
    expect(getAllowedTransitionActions('PROGRAMMEE', 'agent')).toEqual(['assigner', 'deconfirmer']);
    // Phase 11.1 : EN_LIVRAISON (legacy) = delivery_state assigned → « démarrer la
    // livraison » est désormais légale (agent inclus).
    expect(getAllowedTransitionActions('EN_LIVRAISON', 'agent')).toEqual(['demarrer_livraison']);
  });

  it('keeps cash and closure actions for owner and manager roles', () => {
    expect(getAllowedTransitionActions('EN_LIVRAISON', 'owner')).toEqual([
      'demarrer_livraison',
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

  describe('Phase 11 — « programmer » supplante « confirmer » dans les surfaces', () => {
    it('expose programmer (et masque confirmer) dès « À appeler »', () => {
      const actions = getAllowedTransitionActions('A_APPELER', 'agent');
      expect(actions).toContain('programmer');
      expect(actions).toContain('confirmer');

      // La surface utilisateur masque confirmer quand programmer est disponible.
      const visible = visibleAllowedActions(actions);
      expect(visible).toContain('programmer');
      expect(visible).not.toContain('confirmer');
      expect(visible).toEqual(['journaliser_appel', 'programmer']);
    });

    it('laisse confirmer intacte quand programmer est absente', () => {
      expect(visibleAllowedActions(['journaliser_appel', 'confirmer'])).toEqual([
        'journaliser_appel',
        'confirmer',
      ]);
    });

    it('programme une commande déjà confirmée (validated) sans confirmer redondant', () => {
      expect(getAllowedTransitionActions('CONFIRMEE', 'agent')).toEqual([
        'programmer',
        'deconfirmer',
      ]);
    });
  });

  describe('Phase 11.1 — demarrer_livraison (assigned → out_for_delivery)', () => {
    it('est légale à assigned (validated) pour tous les rôles, pas avant', () => {
      const scheduled = legacyStatusToDimensions('PROGRAMMEE'); // delivery=scheduled
      const assigned = legacyStatusToDimensions('EN_LIVRAISON'); // delivery=assigned

      expect(getAllowedTransitionActionsForDimensions(scheduled, 'agent')).not.toContain(
        'demarrer_livraison',
      );
      for (const role of ['owner', 'manager', 'agent'] as const) {
        expect(getAllowedTransitionActionsForDimensions(assigned, role)).toContain(
          'demarrer_livraison',
        );
      }
    });

    it("n'est plus légale une fois en cours de livraison (out_for_delivery)", () => {
      const outForDelivery = {
        ...legacyStatusToDimensions('EN_LIVRAISON'),
        deliveryState: 'out_for_delivery' as const,
      };
      const actions = getAllowedTransitionActionsForDimensions(outForDelivery, 'owner');
      expect(actions).not.toContain('demarrer_livraison');
      expect(actions).toContain('livrer');
    });

    it('ne change que delivery_state → out_for_delivery (aucun autre champ)', () => {
      const patch = buildTransitionDimensionPatch(
        'demarrer_livraison',
        legacyStatusToDimensions('EN_LIVRAISON'),
      );
      expect(patch).toEqual({ deliveryState: 'out_for_delivery' });
    });

    it('partage la cible EN_LIVRAISON mais reste exclue de la résolution par target', () => {
      // « assigner » reste l'action résolue par target EN_LIVRAISON.
      expect(getTransitionActionForTarget('EN_LIVRAISON', 'owner')).toBe('assigner');
    });
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
