import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

// Lot 7 (migration 0089) — list_orders_keyset remplace le chargement large + tri/pagination JS
// de lib/actions/orders.ts:listOrdersForPageData/fetchOrdersPageData quand aucune recherche
// texte n'est active. Contrat verrouillé en PHASE A/B : reproduire exactement les 7 prédicats
// (matchesOrderSavedView/orderMatchesPeriod), le tri sur les colonnes générées sort_at/
// next_action_at (migration 0044), et le keyset tuple (sort, id) sans doublon ni trou entre
// pages. a-appeler filtre sur `created_at` mais trie/paginate sur `sort_at` (champs différents,
// piège identifié en PHASE A).
//
// TB-CPT (migration 0149) — en-livraison/annulees-retours exigeaient un AND composé état+
// transition dans la fenêtre : cette RPC sert la liste RÉELLEMENT rendue au clic depuis le
// Tableau (chemin sans recherche, majoritaire), et portait le même gabarit que le compteur
// get_order_view_counts (0088) — son propre commentaire disait explicitement l'avoir répliqué
// pour ne pas diverger. Corrigé en lock-step avec 0088/0081 : état courant SEUL.

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'orders-keyset-rls-pw';
const createdUserIds: string[] = [];

const skipIfNoServiceRole = !serviceRoleKey ? it.skip : it;

type AdminClient = SupabaseClient<Database>;

function adminClient(): AdminClient {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createConfirmedUser(admin: AdminClient, email: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('User creation failed');
  createdUserIds.push(data.user.id);
  return data.user.id;
}

async function waitForMerchantAccount(admin: AdminClient, userId: string) {
  for (let i = 0; i < 20; i++) {
    const { data } = await admin
      .from('merchant_account')
      .select('id')
      .eq('owner_user_id', userId)
      .limit(1)
      .maybeSingle();
    if (data?.id) return data.id;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('merchant_account not found after 20 retries');
}

async function signIn(email: string) {
  const client = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  await client.auth.signInWithPassword({ email, password });
  return client;
}

async function createOwnerFixture(label: string) {
  const admin = adminClient();
  const email = `orders-keyset-${label}-${Date.now()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  return { admin, email, merchantAccountId, userId };
}

async function addMember(admin: AdminClient, merchantAccountId: string, role: 'agent' | 'manager') {
  const email = `orders-keyset-member-${role}-${Date.now()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  await admin.from('merchant_account').delete().eq('owner_user_id', userId);
  await admin
    .from('merchant_member')
    .insert({ merchant_account_id: merchantAccountId, role, user_id: userId });
  return { email, userId };
}

async function createShop(admin: AdminClient, merchantAccountId: string) {
  const { data, error } = await admin
    .from('shop')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_domain: `okp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.myshopify.com`,
      access_token_encrypted: 'test-token',
      scopes: 'read_orders',
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('shop insert failed');
  return data.id;
}

async function createCustomer(
  admin: AdminClient,
  merchantAccountId: string,
  opts: { fullName: string; phone: string },
) {
  const { data, error } = await admin
    .from('customer')
    .insert({
      full_name: opts.fullName,
      merchant_account_id: merchantAccountId,
      phone: opts.phone,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('customer insert failed');
  return data.id;
}

type Dimensions = {
  callState: string;
  deliveryState: string;
  orderState: string;
};

async function createDriver(admin: AdminClient, merchantAccountId: string) {
  const { data, error } = await admin
    .from('driver')
    .insert({
      full_name: 'Livreur Test',
      is_active: true,
      merchant_account_id: merchantAccountId,
      phone: '+221770000000',
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('driver insert failed');
  return data.id;
}

// orders_dispatch_requires_driver (0057) : assigned_driver_id obligatoire dès que
// delivery_state ∈ {assigned, out_for_delivery}.
const DISPATCH_DELIVERY_STATES = new Set(['assigned', 'out_for_delivery']);

async function insertOrder(
  admin: AdminClient,
  merchantAccountId: string,
  opts: {
    assignedDriverId?: string | null;
    createdAt?: string;
    createdAtShopify?: string | null;
    customerId?: string | null;
    dimensions: Dimensions;
    shopId?: string | null;
    totalAmount?: number;
  },
) {
  const createdAt = opts.createdAt ?? new Date().toISOString();
  const assignedDriverId =
    opts.assignedDriverId ??
    (DISPATCH_DELIVERY_STATES.has(opts.dimensions.deliveryState)
      ? await createDriver(admin, merchantAccountId)
      : null);
  const { data, error } = await admin
    .from('orders')
    .insert({
      assigned_driver_id: assignedDriverId,
      call_state: opts.dimensions.callState,
      cash_state: 'not_due',
      created_at: createdAt,
      created_at_shopify: opts.createdAtShopify ?? createdAt,
      currency: 'XOF',
      customer_id: opts.customerId ?? null,
      delivery_state: opts.dimensions.deliveryState,
      merchant_account_id: merchantAccountId,
      order_number: `OKP-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      order_state: opts.dimensions.orderState,
      ...(opts.shopId ? { shop_id: opts.shopId } : {}),
      total_amount: opts.totalAmount ?? 1000,
    })
    .select('id, sort_at')
    .single();
  if (error || !data) throw error ?? new Error('order insert failed');
  return data;
}

async function insertTransition(
  admin: AdminClient,
  merchantAccountId: string,
  actorUserId: string,
  opts: { createdAt: string; orderId: string; toStatus: string },
) {
  const { error } = await admin.from('order_state_transition').insert({
    actor_user_id: actorUserId,
    created_at: opts.createdAt,
    merchant_account_id: merchantAccountId,
    order_id: opts.orderId,
    to_status: opts.toStatus,
  });
  if (error) throw error;
}

type KeysetRow = { id: string; sort_at: string; next_action_at: string };

async function fetchPage(
  client: SupabaseClient<Database>,
  args: {
    merchantAccountId: string;
    view: string;
    from: string;
    to: string;
    shopId?: string | null;
    cursorSort?: string | null;
    cursorId?: string | null;
    limit?: number;
  },
): Promise<KeysetRow[]> {
  const { data, error } = await client.rpc('list_orders_keyset', {
    p_cursor_id: args.cursorId ?? undefined,
    p_cursor_sort: args.cursorSort ?? undefined,
    p_from: args.from,
    p_limit: args.limit ?? 25,
    p_merchant_id: args.merchantAccountId,
    p_shop_id: args.shopId ?? undefined,
    p_to: args.to,
    p_view: args.view,
  });
  if (error) throw error;
  return (data ?? []) as KeysetRow[];
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id);
  }
  createdUserIds.length = 0;
});

describe('list_orders_keyset (Lot 7, 0089)', () => {
  skipIfNoServiceRole('toutes : tri sort_at DESC, id DESC en tie-break', async () => {
    const { admin, email, merchantAccountId } = await createOwnerFixture('sort-order');
    const from = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const dims: Dimensions = {
      callState: 'to_call',
      deliveryState: 'unassigned',
      orderState: 'open',
    };

    const older = await insertOrder(admin, merchantAccountId, {
      createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
      dimensions: dims,
    });
    const newer = await insertOrder(admin, merchantAccountId, {
      createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      dimensions: dims,
    });

    const client = await signIn(email);
    const page = await fetchPage(client, { from, merchantAccountId, to, view: 'toutes' });

    expect(page.map((row) => row.id)).toEqual([newer.id, older.id]);
  });

  skipIfNoServiceRole('pagination : page 1 → curseur → page 2, sans doublon ni trou', async () => {
    const { admin, email, merchantAccountId } = await createOwnerFixture('pagination');
    const from = new Date(Date.now() - 20 * 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const dims: Dimensions = {
      callState: 'to_call',
      deliveryState: 'unassigned',
      orderState: 'open',
    };

    const inserted = [];
    for (let i = 0; i < 5; i++) {
      inserted.push(
        await insertOrder(admin, merchantAccountId, {
          createdAt: new Date(Date.now() - (10 - i) * 86_400_000).toISOString(),
          dimensions: dims,
        }),
      );
    }
    // Ordre attendu (sort_at DESC) = insertion inverse (le plus récent d'abord).
    const expectedOrder = [...inserted].reverse().map((row) => row.id);

    const client = await signIn(email);
    const page1 = await fetchPage(client, {
      from,
      limit: 3,
      merchantAccountId,
      to,
      view: 'toutes',
    });
    expect(page1).toHaveLength(3);

    const cursorRow = page1[page1.length - 1];
    const page2 = await fetchPage(client, {
      cursorId: cursorRow.id,
      cursorSort: cursorRow.sort_at,
      from,
      limit: 3,
      merchantAccountId,
      to,
      view: 'toutes',
    });
    expect(page2).toHaveLength(2);

    const allIds = [...page1, ...page2].map((row) => row.id);
    expect(allIds).toEqual(expectedOrder);
    expect(new Set(allIds).size).toBe(5); // aucun doublon
  });

  skipIfNoServiceRole(
    'tie-breaker id : deux commandes au même sort_at ne se dupliquent ni ne disparaissent',
    async () => {
      const { admin, email, merchantAccountId } = await createOwnerFixture('tie-break');
      const from = new Date(Date.now() - 10 * 86_400_000).toISOString();
      const to = new Date(Date.now() + 86_400_000).toISOString();
      const sameInstant = new Date(Date.now() - 5 * 86_400_000).toISOString();
      const dims: Dimensions = {
        callState: 'to_call',
        deliveryState: 'unassigned',
        orderState: 'open',
      };

      const first = await insertOrder(admin, merchantAccountId, {
        createdAt: sameInstant,
        dimensions: dims,
      });
      const second = await insertOrder(admin, merchantAccountId, {
        createdAt: sameInstant,
        dimensions: dims,
      });

      const client = await signIn(email);
      const page1 = await fetchPage(client, {
        from,
        limit: 1,
        merchantAccountId,
        to,
        view: 'toutes',
      });
      expect(page1).toHaveLength(1);

      const cursorRow = page1[0];
      const page2 = await fetchPage(client, {
        cursorId: cursorRow.id,
        cursorSort: cursorRow.sort_at,
        from,
        limit: 1,
        merchantAccountId,
        to,
        view: 'toutes',
      });
      expect(page2).toHaveLength(1);

      const ids = [page1[0].id, page2[0].id];
      expect(new Set(ids)).toEqual(new Set([first.id, second.id]));
      expect(ids[0]).not.toBe(ids[1]);
    },
  );

  skipIfNoServiceRole(
    'a-appeler : filtre sur created_at, trie/paginate sur sort_at (champs différents)',
    async () => {
      const { admin, email, merchantAccountId } = await createOwnerFixture('a-appeler-fields');
      const from = new Date(Date.now() - 10 * 86_400_000);
      const to = new Date(Date.now() - 5 * 86_400_000);
      const dims: Dimensions = {
        callState: 'to_call',
        deliveryState: 'unassigned',
        orderState: 'open',
      };

      // created_at DANS la fenêtre, created_at_shopify (donc sort_at) très ancien : doit
      // rester incluse (filtre sur created_at) et malgré tout renvoyée triée par sort_at.
      const oldSortAt = await insertOrder(admin, merchantAccountId, {
        createdAt: from.toISOString(),
        createdAtShopify: new Date(Date.now() - 365 * 86_400_000).toISOString(),
        dimensions: dims,
      });
      const recentSortAt = await insertOrder(admin, merchantAccountId, {
        createdAt: to.toISOString(),
        dimensions: dims,
      });

      const client = await signIn(email);
      const page = await fetchPage(client, {
        from: from.toISOString(),
        merchantAccountId,
        to: to.toISOString(),
        view: 'a-appeler',
      });

      expect(page.map((row) => row.id)).toEqual([recentSortAt.id, oldSortAt.id]);
    },
  );

  skipIfNoServiceRole('tentee-a-rappeler : tri ASC sur next_action_at', async () => {
    const { admin, email, merchantAccountId } = await createOwnerFixture('tentee-asc');
    const from = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const dims: Dimensions = {
      callState: 'callback',
      deliveryState: 'unassigned',
      orderState: 'open',
    };

    const earlier = await insertOrder(admin, merchantAccountId, {
      createdAt: new Date(Date.now() - 8 * 86_400_000).toISOString(),
      dimensions: dims,
    });
    const later = await insertOrder(admin, merchantAccountId, {
      createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      dimensions: dims,
    });

    const client = await signIn(email);
    const page = await fetchPage(client, {
      from,
      merchantAccountId,
      to,
      view: 'tentee-a-rappeler',
    });

    expect(page.map((row) => row.id)).toEqual([earlier.id, later.id]);
  });

  skipIfNoServiceRole(
    'TB-CPT en-livraison : état courant seul — une transition vieille de 20 jours (hors fenêtre 7j) apparaît quand même dans la liste',
    async () => {
      const { admin, email, merchantAccountId, userId } =
        await createOwnerFixture('en-livraison-state-only');
      const from = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const to = new Date().toISOString();
      const staleTransition = new Date(Date.now() - 20 * 86_400_000).toISOString();
      const recentTransition = new Date(Date.now() - 2 * 86_400_000).toISOString();

      // Rouge avant / vert après : état courant OK, transition hors fenêtre p_from/p_to —
      // absente de la page avant ce lot, doit apparaître après.
      const stale = await insertOrder(admin, merchantAccountId, {
        createdAt: staleTransition,
        dimensions: {
          callState: 'validated',
          deliveryState: 'out_for_delivery',
          orderState: 'open',
        },
      });
      await insertTransition(admin, merchantAccountId, userId, {
        createdAt: staleTransition,
        orderId: stale.id,
        toStatus: 'EN_LIVRAISON',
      });

      // Contrôle positif : transition récente, dans la fenêtre — reste dans la page.
      const recent = await insertOrder(admin, merchantAccountId, {
        createdAt: recentTransition,
        dimensions: {
          callState: 'validated',
          deliveryState: 'out_for_delivery',
          orderState: 'open',
        },
      });
      await insertTransition(admin, merchantAccountId, userId, {
        createdAt: recentTransition,
        orderId: recent.id,
        toStatus: 'EN_LIVRAISON',
      });

      // Transition qualifiante mais état courant a changé depuis (livrée) → exclu : l'état
      // courant reste la condition, seule la fenêtre de transition disparaît.
      const delivered = await insertOrder(admin, merchantAccountId, {
        createdAt: staleTransition,
        dimensions: { callState: 'validated', deliveryState: 'delivered', orderState: 'completed' },
      });
      await insertTransition(admin, merchantAccountId, userId, {
        createdAt: staleTransition,
        orderId: delivered.id,
        toStatus: 'EN_LIVRAISON',
      });

      const client = await signIn(email);
      const page = await fetchPage(client, {
        from,
        merchantAccountId,
        to,
        view: 'en-livraison',
      });

      expect(new Set(page.map((row) => row.id))).toEqual(new Set([stale.id, recent.id]));
    },
  );

  skipIfNoServiceRole(
    'TB-CPT annulees-retours : état courant seul — une transition vieille de 20 jours apparaît quand même dans la liste',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture(
        'annulees-retours-state-only',
      );
      const from = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const to = new Date().toISOString();
      const staleTransition = new Date(Date.now() - 20 * 86_400_000).toISOString();
      const recentTransition = new Date(Date.now() - 2 * 86_400_000).toISOString();

      // Rouge avant / vert après.
      const stale = await insertOrder(admin, merchantAccountId, {
        createdAt: staleTransition,
        dimensions: { callState: 'validated', deliveryState: 'unassigned', orderState: 'returned' },
      });
      await insertTransition(admin, merchantAccountId, userId, {
        createdAt: staleTransition,
        orderId: stale.id,
        toStatus: 'REFUSEE',
      });

      // Contrôle positif.
      const recent = await insertOrder(admin, merchantAccountId, {
        createdAt: recentTransition,
        dimensions: {
          callState: 'validated',
          deliveryState: 'unassigned',
          orderState: 'cancelled',
        },
      });
      await insertTransition(admin, merchantAccountId, userId, {
        createdAt: recentTransition,
        orderId: recent.id,
        toStatus: 'ANNULEE',
      });

      // État courant revenu open depuis → exclu.
      const reopened = await insertOrder(admin, merchantAccountId, {
        createdAt: staleTransition,
        dimensions: { callState: 'to_call', deliveryState: 'unassigned', orderState: 'open' },
      });
      await insertTransition(admin, merchantAccountId, userId, {
        createdAt: staleTransition,
        orderId: reopened.id,
        toStatus: 'ANNULEE',
      });

      const client = await signIn(email);
      const page = await fetchPage(client, {
        from,
        merchantAccountId,
        to,
        view: 'annulees-retours',
      });

      expect(new Set(page.map((row) => row.id))).toEqual(new Set([stale.id, recent.id]));
    },
  );

  skipIfNoServiceRole(
    'scope boutique optionnel : exclut les commandes des autres boutiques',
    async () => {
      const { admin, email, merchantAccountId } = await createOwnerFixture('shop-scope');
      const shopA = await createShop(admin, merchantAccountId);
      const shopB = await createShop(admin, merchantAccountId);
      const from = new Date(Date.now() - 10 * 86_400_000).toISOString();
      const to = new Date(Date.now() + 86_400_000).toISOString();
      const dims: Dimensions = {
        callState: 'to_call',
        deliveryState: 'unassigned',
        orderState: 'open',
      };

      const orderA = await insertOrder(admin, merchantAccountId, {
        dimensions: dims,
        shopId: shopA,
      });
      await insertOrder(admin, merchantAccountId, { dimensions: dims, shopId: shopB });

      const client = await signIn(email);
      const page = await fetchPage(client, {
        from,
        merchantAccountId,
        shopId: shopA,
        to,
        view: 'toutes',
      });

      expect(page.map((row) => row.id)).toEqual([orderA.id]);
    },
  );

  skipIfNoServiceRole(
    'bornes de fenêtre INCLUSIVES aux deux extrémités, commande hors fenêtre exclue',
    async () => {
      const { admin, email, merchantAccountId } = await createOwnerFixture('window-bounds');
      const from = new Date(Date.now() - 10 * 86_400_000);
      const to = new Date(Date.now() - 5 * 86_400_000);
      const dims: Dimensions = {
        callState: 'to_call',
        deliveryState: 'unassigned',
        orderState: 'open',
      };

      const onFrom = await insertOrder(admin, merchantAccountId, {
        createdAt: from.toISOString(),
        dimensions: dims,
      });
      const onTo = await insertOrder(admin, merchantAccountId, {
        createdAt: to.toISOString(),
        dimensions: dims,
      });
      await insertOrder(admin, merchantAccountId, {
        createdAt: new Date(Date.now() - 1 * 86_400_000).toISOString(), // après `to`
        dimensions: dims,
      });

      const client = await signIn(email);
      const page = await fetchPage(client, {
        from: from.toISOString(),
        merchantAccountId,
        to: to.toISOString(),
        view: 'toutes',
      });

      expect(new Set(page.map((row) => row.id))).toEqual(new Set([onFrom.id, onTo.id]));
    },
  );

  skipIfNoServiceRole(
    'aplatit customer_full_name/customer_phone depuis la table customer',
    async () => {
      const { admin, email, merchantAccountId } = await createOwnerFixture('customer-flatten');
      const from = new Date(Date.now() - 10 * 86_400_000).toISOString();
      const to = new Date(Date.now() + 86_400_000).toISOString();
      const customerId = await createCustomer(admin, merchantAccountId, {
        fullName: 'Awa Diop',
        phone: '+221771234567',
      });
      await insertOrder(admin, merchantAccountId, {
        customerId,
        dimensions: { callState: 'to_call', deliveryState: 'unassigned', orderState: 'open' },
      });

      const client = await signIn(email);
      const { data, error } = await client.rpc('list_orders_keyset', {
        p_from: from,
        p_merchant_id: merchantAccountId,
        p_to: to,
        p_view: 'toutes',
      });
      if (error) throw error;

      const row = (data ?? [])[0] as { customer_full_name: string; customer_phone: string };
      expect(row.customer_full_name).toBe('Awa Diop');
      expect(row.customer_phone).toBe('+221771234567');
    },
  );

  skipIfNoServiceRole(
    'agent : mêmes résultats que owner (aucune restriction de rôle)',
    async () => {
      const { admin, merchantAccountId } = await createOwnerFixture('agent-parity');
      const from = new Date(Date.now() - 10 * 86_400_000).toISOString();
      const to = new Date(Date.now() + 86_400_000).toISOString();

      const seeded = await insertOrder(admin, merchantAccountId, {
        dimensions: { callState: 'to_call', deliveryState: 'unassigned', orderState: 'open' },
      });

      const { email: agentEmail } = await addMember(admin, merchantAccountId, 'agent');
      const client = await signIn(agentEmail);
      const page = await fetchPage(client, { from, merchantAccountId, to, view: 'toutes' });

      expect(page.map((row) => row.id)).toEqual([seeded.id]);
    },
  );

  skipIfNoServiceRole(
    'isolation tenant : owner du tenant B lisant le merchant_id du tenant A obtient 0 ligne (RLS, pas une erreur)',
    async () => {
      const { admin, merchantAccountId: merchantA } = await createOwnerFixture('tenant-a');
      await insertOrder(admin, merchantA, {
        dimensions: { callState: 'to_call', deliveryState: 'unassigned', orderState: 'open' },
      });
      const { email: emailB } = await createOwnerFixture('tenant-b');
      const clientB = await signIn(emailB);

      const page = await fetchPage(clientB, {
        from: new Date(Date.now() - 30 * 86_400_000).toISOString(),
        merchantAccountId: merchantA,
        to: new Date(Date.now() + 86_400_000).toISOString(),
        view: 'toutes',
      });

      expect(page).toHaveLength(0);
    },
  );
});
