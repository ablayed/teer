/**
 * FIX-UI-REFUS-01 — retrait de l'action « Refuser par le client ».
 *
 * Ce fichier mesure les TROIS niveaux du retrait, séparément, parce qu'un seul d'entre
 * eux ne prouve rien :
 *
 *  1. AUCUNE surface ne propose plus l'action — le retrait est posé une fois dans le
 *     catalogue (`getAllowedTransitionActionsForDimensions`), d'où toutes les surfaces
 *     dérivent leurs entrées ; et aucun fichier de `components/`/`app/` ne porte plus
 *     le libellé d'action.
 *  2. L'ACTION SERVEUR refuse une nouvelle transition, par un code nommé
 *     (`action_retired`), même appelée par un rôle autorisé qui contourne l'interface.
 *     C'est ce volet, et lui seul, qui distingue un retrait réel d'un retrait décoratif.
 *  3. La MACHINE À ÉTATS, le patch de dimensions et la résolution par cible sont
 *     INCHANGÉS — donc les commandes déjà en REFUSEE restent valides et gardent leur
 *     sortie (`desannuler`).
 *
 * Le libellé du STATUT « Refusée » est vérifié présent : une commande historique doit
 * continuer de s'afficher lisiblement. C'est la distinction action / affichage.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  canTransition,
  getAllowedTransitions,
  isTerminal,
  orderStatusLabels,
  orderStatuses,
} from '@/lib/domain/order-state-machine';
import {
  type TransitionAction,
  buildTransitionDimensionPatch,
  canRolePerformAction,
  getAllowedTransitionActions,
  getAllowedTransitionActionsForDimensions,
  getTransitionActionForTarget,
  isRetiredTransitionAction,
  legacyStatusToDimensions,
  retiredTransitionActions,
  transitionCatalog,
  visibleAllowedActions,
} from '@/lib/domain/order-transition-actions';

const ROLES = ['owner', 'manager', 'agent'] as const;

const auditInsert = vi.fn(() => Promise.resolve({ error: null }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
  },
}));

vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/supabase-js')>();
  return {
    ...actual,
    // Seul le client service-role passe par createClient dans transitions.ts : c'est lui
    // qui écrirait l'audit. On veut prouver qu'il n'est jamais sollicité.
    createClient: () => ({
      from: () => ({ insert: auditInsert }),
    }),
  };
});

const { performTransitionForContext } = await import('@/lib/actions/transitions');

// Commande « À appeler » : l'état où « Refuser par le client » était proposée.
const TO_CALL_ORDER = {
  id: 'order-1',
  merchant_account_id: 'merchant-1',
  shop_id: 'shop-1',
  assigned_driver_id: null,
  attempt_count: 0,
  call_state: 'to_call',
  cancel_reason: null,
  cancel_reasons: null,
  cash_state: 'not_due',
  cod_status: 'A_APPELER',
  delivery_state: 'unassigned',
  next_contact_at: null,
  order_state: 'open',
  scheduled_for: null,
};

// Client serveur factice qui COMPTE ses accès : le refus doit intervenir avant toute
// lecture (`reads`) et avant tout appel de RPC (`rpc`). Aucune écriture n'est possible
// puisque `transition_order` est le seul chemin d'écriture d'état.
function countingServerClient(row: Record<string, unknown>) {
  const rpc = vi.fn((_fn: string, _args: Record<string, unknown>) =>
    Promise.resolve({ data: row.cod_status, error: null }),
  );
  const state = { reads: 0 };
  const client = {
    rpc,
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => {
            state.reads += 1;
            return Promise.resolve({ data: row, error: null });
          },
        }),
      }),
    }),
  };
  return { client: client as unknown as SupabaseClient, rpc, state };
}

function listSourceFiles(root: string): string[] {
  const found: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (['.ts', '.tsx'].includes(extname(full))) {
        found.push(full);
      }
    }
  }
  walk(root);
  return found;
}

beforeEach(() => {
  auditInsert.mockClear();
});

describe('FIX-UI-REFUS-01 — niveau 1 : aucune surface ne propose plus l’action', () => {
  it('« refuser » est déclarée retirée, et elle seule', () => {
    expect([...retiredTransitionActions]).toEqual(['refuser']);
    expect(isRetiredTransitionAction('refuser')).toBe(true);
    expect(isRetiredTransitionAction('annuler')).toBe(false);
  });

  it("n'apparaît dans AUCUNE liste d'actions offertes, quel que soit le statut et le rôle", () => {
    for (const status of orderStatuses) {
      for (const role of ROLES) {
        const actions = getAllowedTransitionActions(status, role);
        expect(actions, `${status}/${role}`).not.toContain('refuser');
        // La surface applique encore `visibleAllowedActions` par-dessus : elle ne peut
        // pas réintroduire ce que la liste source ne contient plus.
        expect(visibleAllowedActions(actions), `${status}/${role}`).not.toContain('refuser');
      }
    }
  });

  it("n'apparaît pas non plus sur les dimensions où elle était légale (unassigned, scheduled)", () => {
    const base = legacyStatusToDimensions('CONFIRMEE');
    for (const deliveryState of ['unassigned', 'scheduled'] as const) {
      for (const role of ROLES) {
        expect(
          getAllowedTransitionActionsForDimensions({ ...base, deliveryState }, role),
          `${deliveryState}/${role}`,
        ).not.toContain('refuser');
      }
    }
  });

  it("aucun fichier de components/ ou app/ ne porte plus le libellé d'action", () => {
    // Le libellé d'ACTION avait deux formes : « Refuser par le client » (file d'appel)
    // et « Refuser ». On cherche des littéraux entre guillemets de code, pas le mot en
    // prose — un commentaire qui cite « Refuser » avec des guillemets français reste
    // légitime et n'est jamais rendu.
    const pattern = /(['"`])Refuser(?: par le client)?\1/;
    const offenders = [...listSourceFiles('components'), ...listSourceFiles('app')].filter((file) =>
      pattern.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it("le libellé interne du catalogue n'est rendu par aucune surface", () => {
    // `transitionCatalog` garde son entrée `refuser` (la couche 2 n'est pas amputée) et
    // avec elle un champ `label` inerte. Ce test mesure ce qui rend ce champ inerte :
    // aucune surface ne lit le catalogue, toutes passent par les actions offertes.
    expect(transitionCatalog.some((item) => item.action === 'refuser')).toBe(true);
    const readers = [...listSourceFiles('components'), ...listSourceFiles('app')].filter((file) =>
      readFileSync(file, 'utf8').includes('transitionCatalog'),
    );
    expect(readers).toEqual([]);
  });
});

describe("FIX-UI-REFUS-01 — niveau 2 : l'action serveur refuse par un code nommé", () => {
  it.each(ROLES)(
    'refuse un appel direct de %s, par action_retired, sans aucune lecture ni écriture',
    async (role) => {
      const { client, rpc, state } = countingServerClient(TO_CALL_ORDER);

      const result = await performTransitionForContext({
        action: 'refuser',
        actorUserId: 'user-1',
        orderId: 'order-1',
        role,
        supabase: client as never,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe('action_retired');
        expect(result.message).toContain('Refuser par le client');
        // Le message dit ce qui remplace le geste, sinon l'utilisateur reste sans issue.
        expect(result.message).toContain('Annuler la commande');
        expect(result.message).toContain('Marquer retournée');
      }

      // La garde est PRÉ-lecture et PRÉ-mutation : rien n'est lu, la RPC (seul chemin
      // d'écriture d'état) n'est pas appelée, aucun audit n'est posé.
      expect(state.reads).toBe(0);
      expect(rpc).not.toHaveBeenCalled();
      expect(auditInsert).not.toHaveBeenCalled();
    },
  );

  it('le refus ne vient pas du RBAC : owner et manager ont toujours le droit sur cette action', () => {
    // Sans ce contrôle, un `canRolePerformAction` cassé rendrait le test ci-dessus vert
    // pour la mauvaise raison (refus de droit au lieu de refus de retrait).
    expect(canRolePerformAction('owner', 'refuser')).toBe(true);
    expect(canRolePerformAction('manager', 'refuser')).toBe(true);
  });

  it('couvre aussi les chemins qui résolvent l’action par STATUT CIBLE', async () => {
    // `transitionOrderStatusAction` (to=REFUSEE), `updateCodStatusAction`
    // (codStatus=REFUSEE) et `logCallAction` (issue REFUSEE) passent tous par
    // `getTransitionActionForTarget` puis par `performTransitionForContext`. La
    // résolution par cible est volontairement inchangée — c'est la garde de retrait,
    // en aval, qui les refuse tous les trois avec le même code.
    const resolved = getTransitionActionForTarget('REFUSEE', 'owner');
    expect(resolved).toBe('refuser');

    const { client, rpc, state } = countingServerClient(TO_CALL_ORDER);
    const result = await performTransitionForContext({
      action: resolved as TransitionAction,
      actorUserId: 'user-1',
      orderId: 'order-1',
      role: 'owner',
      supabase: client as never,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('action_retired');
    }
    expect(state.reads).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('les autres actions du menu passent toujours la garde (non-régression)', async () => {
    // Le retrait doit être ciblé : si la garde refusait plus large, ce test rougirait.
    const { client, rpc } = countingServerClient({
      ...TO_CALL_ORDER,
      call_state: 'callback',
      cod_status: 'TENTEE',
    });

    const result = await performTransitionForContext({
      action: 'journaliser_appel',
      actorUserId: 'user-1',
      orderId: 'order-1',
      role: 'agent',
      supabase: client as never,
    });

    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe('FIX-UI-REFUS-01 — niveau 3 : machine à états, patch et lignes existantes intacts', () => {
  it('la table des transitions légales garde REFUSEE comme cible (couche 1 non touchée)', () => {
    expect(canTransition('A_APPELER', 'REFUSEE')).toBe(true);
    expect(canTransition('TENTEE', 'REFUSEE')).toBe(true);
    expect(canTransition('CONFIRMEE', 'REFUSEE')).toBe(true);
    expect(canTransition('PROGRAMMEE', 'REFUSEE')).toBe(true);
    // Déjà retirée par le lot « Refuser → Reprogrammer », sans rapport avec celui-ci.
    expect(canTransition('EN_LIVRAISON', 'REFUSEE')).toBe(false);
  });

  it('le patch de dimensions de « refuser » est inchangé (couche 2 non amputée)', () => {
    const patch = buildTransitionDimensionPatch(
      'refuser',
      legacyStatusToDimensions('CONFIRMEE'),
      {},
    );
    expect(patch).toEqual({
      callState: 'validated',
      cashState: 'not_due',
      deliveryState: 'failed',
      orderState: 'cancelled',
      cancelReason: 'refused',
    });
  });

  it('une commande DÉJÀ en REFUSEE garde sa sortie : désannuler, pour owner et manager', () => {
    // Mesure décisive du §2.2 du mandat : les lignes existantes ne sont pas bloquées.
    // Côté couche 1, REFUSEE est déclarée TERMINALE (aucune cible) — mais la légalité
    // effective est portée par les dimensions, et `performTransitionForContext` ne
    // consulte que celles-ci ; c'est le mécanisme préexistant qui rend `desannuler`
    // possible sur une commande refusée (order_state='cancelled').
    expect(getAllowedTransitions('REFUSEE')).toEqual([]);
    expect(isTerminal('REFUSEE')).toBe(true);

    expect(getAllowedTransitionActions('REFUSEE', 'owner')).toEqual(['desannuler']);
    expect(getAllowedTransitionActions('REFUSEE', 'manager')).toEqual(['desannuler']);
    expect(getAllowedTransitionActions('REFUSEE', 'agent')).toEqual([]);
  });

  it("le libellé du STATUT « Refusée » est conservé — c'est l'affichage, pas l'action", () => {
    expect(orderStatusLabels.REFUSEE).toBe('Refusée');
  });

  it('« Marquer retournée » reste la voie de retour après livraison, et elle cible REFUSEE', () => {
    const markReturned: TransitionAction = 'mark_returned';
    expect(isRetiredTransitionAction(markReturned)).toBe(false);
    expect(getAllowedTransitionActions('LIVREE', 'owner')).toContain('mark_returned');
    expect(transitionCatalog.find((item) => item.action === 'mark_returned')?.target).toBe(
      'REFUSEE',
    );
  });
});
