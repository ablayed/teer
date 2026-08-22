import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Gap 4 — garde TS de performReassignDriverForContext (lib/actions/orders.ts), miroir
// de celle de performTransitionForContext (transitions.ts, migration 0133) : un livreur
// ne peut être réassigné qu'à une commande d'une boutique qu'il sert. La garde SQL de
// reassign_order_driver (migration 0139) reste le filet incontournable côté base ; ce
// fichier vise UNIQUEMENT la couche TS, atteinte par la Server Action, jamais par un
// test RLS (qui appelle la RPC directement et ne passe jamais par lib/actions/orders.ts).

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
    // Seul le client ADMIN (service-role) passe par createClient dans orders.ts : c'est
    // lui qui écrit audit_log pour order.driver_reassigned.
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

const { performReassignDriverForContext } = await import('@/lib/actions/orders');

const ORDER = {
  id: 'order-1',
  merchant_account_id: 'merchant-1',
  assigned_driver_id: 'driver-old',
  shop_id: 'shop-order',
};

function fakeClient({
  eligible,
  eligibilityError = null,
  reassignError = null,
}: {
  eligible: boolean | null;
  eligibilityError?: { message: string } | null;
  reassignError?: { message: string } | null;
}) {
  const rpc = vi.fn((fn: string, _args: Record<string, unknown>) => {
    if (fn === 'is_driver_in_shop') {
      return Promise.resolve({ data: eligible, error: eligibilityError });
    }
    if (fn === 'reassign_order_driver') {
      return Promise.resolve({ data: null, error: reassignError });
    }
    throw new Error(`RPC inattendue: ${fn}`);
  });

  const client = {
    rpc,
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: ORDER, error: null }),
        }),
      }),
    }),
  };

  return { client: client as unknown as SupabaseClient, rpc };
}

beforeEach(() => {
  auditInsert.mockClear();
});

describe('Gap 4 — performReassignDriverForContext : éligibilité du livreur', () => {
  it('livreur éligible (is_driver_in_shop=true) → réassignation, RPC appelée, audit écrit', async () => {
    const { client, rpc } = fakeClient({ eligible: true });

    const result = await performReassignDriverForContext({
      actorUserId: 'user-1',
      newDriverId: 'driver-new',
      orderId: 'order-1',
      supabase: client as never,
    });

    expect(result.ok).toBe(true);
    const reassignCall = rpc.mock.calls.find(([fn]) => fn === 'reassign_order_driver');
    expect(reassignCall).toBeDefined();
    expect(auditInsert).toHaveBeenCalledTimes(1);
  });

  it('livreur non éligible (is_driver_in_shop=false) → refus AVANT tout appel à reassign_order_driver, aucun audit', async () => {
    const { client, rpc } = fakeClient({ eligible: false });

    const result = await performReassignDriverForContext({
      actorUserId: 'user-1',
      newDriverId: 'driver-foreign',
      orderId: 'order-1',
      supabase: client as never,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('driver_not_in_store');
    }
    expect(rpc).toHaveBeenCalledTimes(1); // is_driver_in_shop seulement.
    expect(rpc.mock.calls.some(([fn]) => fn === 'reassign_order_driver')).toBe(false);
    expect(auditInsert).not.toHaveBeenCalled();
  });

  it("échec de l'appel d'éligibilité (erreur réseau/RPC) → refus fail-closed, jamais un succès silencieux", async () => {
    const { client, rpc } = fakeClient({
      eligible: null,
      eligibilityError: { message: 'connection reset' },
    });

    const result = await performReassignDriverForContext({
      actorUserId: 'user-1',
      newDriverId: 'driver-new',
      orderId: 'order-1',
      supabase: client as never,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('driver_not_in_store');
    }
    expect(rpc.mock.calls.some(([fn]) => fn === 'reassign_order_driver')).toBe(false);
  });
});
