import type { Database } from '@/lib/supabase/database.types';
import { resolveMemberlessDestination } from '@/lib/workspace/memberless-destination';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

function fakeClient(rpcResult: unknown): SupabaseClient<Database> {
  return {
    rpc: vi.fn().mockResolvedValue(rpcResult),
  } as unknown as SupabaseClient<Database>;
}

describe('resolveMemberlessDestination', () => {
  it('route vers /invitation/accept avec une invitation en attente', async () => {
    const supabase = fakeClient({
      data: [{ id: 'inv-1', merchant_account_id: 'm-1', org_name: 'Org', role: 'agent' }],
      error: null,
    });

    await expect(resolveMemberlessDestination(supabase)).resolves.toBe('/invitation/accept');
  });

  it('route vers /invitation/accept avec plusieurs invitations en attente — même branche que une seule', async () => {
    const supabase = fakeClient({
      data: [
        { id: 'inv-1', merchant_account_id: 'm-1', org_name: 'Org A', role: 'agent' },
        { id: 'inv-2', merchant_account_id: 'm-2', org_name: 'Org B', role: 'manager' },
      ],
      error: null,
    });

    await expect(resolveMemberlessDestination(supabase)).resolves.toBe('/invitation/accept');
  });

  it('route vers /onboarding sans aucune invitation en attente', async () => {
    const supabase = fakeClient({ data: [], error: null });

    await expect(resolveMemberlessDestination(supabase)).resolves.toBe('/onboarding');
  });

  it('route vers /onboarding si la RPC échoue — jamais un état bloquant', async () => {
    const supabase = fakeClient({ data: null, error: new Error('boom') });

    await expect(resolveMemberlessDestination(supabase)).resolves.toBe('/onboarding');
  });
});
