import { canSeeCostsInShop, resolveMemberShopAccess } from '@/lib/merchant/member-shop-access';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

// Les cas que la suite RLS ne peut pas produire : une lecture qui échoue, et une boutique rendue
// par la base mais d'un autre compte que celui du membre.
const SHOP = '3f1c6a52-5f5e-4d0a-9a3b-0a1b2c3d4e5f';
const ACCOUNT = '8a1d2b3c-1111-4222-8333-444455556666';

function client(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn(async () => result);
  return { rpc, supabase: { rpc } as unknown as SupabaseClient<Database> };
}

describe('droit d’un membre sur une boutique', () => {
  it('boutique rendue par la session, même compte : accès, avec le rôle de boutique', async () => {
    const { rpc, supabase } = client({
      data: [{ id: SHOP, merchant_account_id: ACCOUNT, role: 'manager' }],
      error: null,
    });
    expect(await resolveMemberShopAccess(supabase, SHOP, ACCOUNT)).toEqual({
      merchantAccountId: ACCOUNT,
      ok: true,
      shopRole: 'manager',
    });
    expect(rpc).toHaveBeenCalledWith('get_my_store', { p_shop_id: SHOP });
  });

  it('aucune ligne : refus', async () => {
    const { supabase } = client({ data: [], error: null });
    expect(await resolveMemberShopAccess(supabase, SHOP, ACCOUNT)).toEqual({
      errorCode: 'forbidden',
      ok: false,
    });
  });

  it('boutique d’un autre compte que celui du membre : refus', async () => {
    const { supabase } = client({
      data: [
        { id: SHOP, merchant_account_id: '99999999-1111-4222-8333-444455556666', role: 'owner' },
      ],
      error: null,
    });
    expect(await resolveMemberShopAccess(supabase, SHOP, ACCOUNT)).toEqual({
      errorCode: 'forbidden',
      ok: false,
    });
  });

  it('lecture en échec : ce n’est ni un accès ni un refus, et le code le dit', async () => {
    const { supabase } = client({ data: null, error: { code: '08006', message: 'panne' } });
    expect(await resolveMemberShopAccess(supabase, SHOP, ACCOUNT)).toEqual({
      errorCode: 'load_failed',
      ok: false,
    });
  });

  it('identifiant mal formé : refus, la base n’est pas interrogée', async () => {
    const { rpc, supabase } = client({ data: [], error: null });
    for (const bad of ['', 'pas-un-identifiant', `${SHOP}x`]) {
      expect(await resolveMemberShopAccess(supabase, bad, ACCOUNT)).toEqual({
        errorCode: 'forbidden',
        ok: false,
      });
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('accès aux coûts : règle commune', () => {
  const roles = ['owner', 'manager', 'agent'] as const;
  it.each(roles.flatMap((account) => roles.map((shop) => [account, shop] as const)))(
    'compte %s, boutique %s',
    (account, shop) => {
      const expected = account !== 'agent' && shop !== 'agent';
      expect(canSeeCostsInShop(account, shop)).toBe(expected);
    },
  );

  it('un rôle inconnu ne voit jamais les coûts', () => {
    expect(canSeeCostsInShop('owner', 'quelconque')).toBe(false);
    expect(canSeeCostsInShop('', 'owner')).toBe(false);
  });
});
