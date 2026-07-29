import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ⚠️ Ce fichier teste UNE SEULE chose : « Invalider » (0116) n'écrit AUCUNE ligne
// `audit_log`. C'est une exception délibérée et documentée à la convention du projet
// (toute action sensible pose normalement un audit) — décision produit du porteur.
// Le test prouve l'ABSENCE, et prouve en miroir que toutes les autres actions écrivent
// toujours leur audit : sans ce second volet, un bug qui casserait l'audit partout
// laisserait ce fichier vert.
//
// La couche RLS (`tests/rls/stock-atomicity.rls.test.ts`) vérifie le même fait côté base ;
// ici on vise le seul endroit qui écrit réellement `audit_log`, c'est-à-dire
// `lib/actions/transitions.ts` via son client service-role.

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
    // Seul le client ADMIN (service-role) passe par createClient dans transitions.ts :
    // c'est lui, et lui seul, qui écrit audit_log.
    createClient: () => ({
      from: (table: string) => {
        if (table !== 'audit_log') {
          throw new Error(`Client admin utilisé pour une table inattendue : ${table}`);
        }
        return { insert: auditInsert };
      },
    }),
  };
});

const { performTransitionForContext } = await import('@/lib/actions/transitions');

const DELIVERED_ORDER = {
  id: 'order-1',
  merchant_account_id: 'merchant-1',
  assigned_driver_id: 'driver-1',
  attempt_count: 0,
  call_state: 'validated',
  cancel_reason: null,
  cancel_reasons: null,
  cash_state: 'collected',
  cod_status: 'LIVREE',
  delivery_state: 'delivered',
  next_contact_at: null,
  order_state: 'completed',
  scheduled_for: null,
};

// Client serveur factice. `performTransitionForContext` lit la commande DEUX fois :
// une fois avant la transition (c'est cette lecture qui décide de la légalité de l'action)
// puis une fois après la RPC. Le stub doit donc renvoyer l'état AVANT au premier appel et
// l'état APRÈS ensuite — sinon la commande paraît déjà transitionnée et l'action est
// refusée en `illegal_transition`.
function fakeServerClient(
  nextStatus: string,
  reloaded: Record<string, unknown>,
  initial: Record<string, unknown> = reloaded,
) {
  const rpc = vi.fn((_fn: string, _args: Record<string, unknown>) =>
    Promise.resolve({ data: nextStatus, error: null }),
  );
  let reads = 0;
  const client = {
    rpc,
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => {
            reads += 1;
            return Promise.resolve({ data: reads === 1 ? initial : reloaded, error: null });
          },
        }),
      }),
    }),
  };
  return { client: client as unknown as SupabaseClient, rpc };
}

beforeEach(() => {
  auditInsert.mockClear();
});

describe("0116 — « Invalider » n'écrit aucun audit", () => {
  it("n'insère AUCUNE ligne audit_log et demande explicitement l'invalidation à la RPC", async () => {
    const { client, rpc } = fakeServerClient(
      'A_APPELER',
      {
        ...DELIVERED_ORDER,
        call_state: 'to_call',
        cash_state: 'not_due',
        cod_status: 'A_APPELER',
        delivery_state: 'unassigned',
        order_state: 'open',
        assigned_driver_id: null,
      },
      DELIVERED_ORDER,
    );

    const result = await performTransitionForContext({
      action: 'invalider',
      actorUserId: 'user-1',
      orderId: 'order-1',
      role: 'owner',
      supabase: client as never,
    });

    expect(result.ok).toBe(true);
    // Le fait central de ce test.
    expect(auditInsert).not.toHaveBeenCalled();

    // Et l'invalidation est bien demandée explicitement (jamais déduite des dimensions).
    const args = rpc.mock.calls[0]?.[1] ?? {};
    expect(args.p_invalidate_delivered).toBe(true);
    expect(args.p_clear_assigned_driver).toBe(true);
    expect(args.p_call_state).toBe('to_call');
    expect(args.p_order_state).toBe('open');
  });

  it("« Marquer retournée » continue, elle, d'écrire son audit — l'exception est bien ciblée", async () => {
    const { client } = fakeServerClient(
      'REFUSEE',
      {
        ...DELIVERED_ORDER,
        cash_state: 'not_due',
        cod_status: 'REFUSEE',
        delivery_state: 'returned',
        order_state: 'returned',
      },
      DELIVERED_ORDER,
    );

    const result = await performTransitionForContext({
      action: 'mark_returned',
      actorUserId: 'user-1',
      orderId: 'order-1',
      role: 'owner',
      supabase: client as never,
    });

    expect(result.ok).toBe(true);
    expect(auditInsert).toHaveBeenCalledTimes(1);
  });

  it.each(['remitted', 'discrepancy'] as const)(
    'refuse une invalidation quand le versement du livreur est déjà enregistré (%s)',
    async (cashState) => {
      // La commande lue est livrée AVEC un versement déjà enregistré.
      const { client, rpc } = fakeServerClient('LIVREE', {
        ...DELIVERED_ORDER,
        cash_state: cashState,
      });

      const result = await performTransitionForContext({
        action: 'invalider',
        actorUserId: 'user-1',
        orderId: 'order-1',
        role: 'owner',
        supabase: client as never,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe('invalid_invalidate_cash_settled');
      }
      // Garde PRÉ-mutation : la RPC n'est même pas appelée, et rien n'est audité.
      expect(rpc).not.toHaveBeenCalled();
      expect(auditInsert).not.toHaveBeenCalled();
    },
  );

  it("interdit l'invalidation à un agent, avant toute lecture de commande", async () => {
    const { client, rpc } = fakeServerClient('A_APPELER', DELIVERED_ORDER);

    const result = await performTransitionForContext({
      action: 'invalider',
      actorUserId: 'user-1',
      orderId: 'order-1',
      role: 'agent',
      supabase: client as never,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('forbidden');
    }
    expect(rpc).not.toHaveBeenCalled();
    expect(auditInsert).not.toHaveBeenCalled();
  });
});
