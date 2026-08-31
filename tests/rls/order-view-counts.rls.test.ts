import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

// Lot 6 (migration 0088) — get_order_view_counts remplace le calcul TS des 7 compteurs de vues
// /commandes (lib/actions/orders.ts:fetchOrdersPageData) quand aucune recherche texte n'est
// active. Contrat : reproduire exactement matchesOrderSavedView + orderMatchesPeriod
// (lib/domain/order-saved-views.ts) — en particulier a-appeler sur `created_at` (pas
// orderQueueDate).
//
// TB-CPT (migration 0149) — en-livraison/annulees-retours exigeaient un AND composé (état
// courant ET transition qualifiante dans la fenêtre) : une commande dans l'état visé depuis
// plus de 7 jours n'était jamais comptée alors qu'elle reste bien dans l'état — mesuré en
// production (24→4, 130→9 selon la vue). Corrigé : état courant SEUL, aligné sur
// matchesOrderSavedView, quelle que soit l'ancienneté de la transition (ou son absence).

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'order-view-counts-rls-pw';
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
  const email = `order-view-counts-${label}-${Date.now()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  return { admin, email, merchantAccountId, userId };
}

async function addMember(admin: AdminClient, merchantAccountId: string, role: 'agent' | 'manager') {
  const email = `order-view-counts-member-${role}-${Date.now()}@example.com`;
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
      shop_domain: `ovc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.myshopify.com`,
      access_token_encrypted: 'test-token',
      scopes: 'read_orders',
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('shop insert failed');
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
// delivery_state ∈ {assigned, out_for_delivery} — un driverId est fourni automatiquement
// pour ces deux états si l'appelant n'en passe pas explicitement.
const DISPATCH_DELIVERY_STATES = new Set(['assigned', 'out_for_delivery']);

async function insertOrder(
  admin: AdminClient,
  merchantAccountId: string,
  opts: {
    assignedDriverId?: string | null;
    createdAt?: string;
    createdAtShopify?: string | null;
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
      delivery_state: opts.dimensions.deliveryState,
      merchant_account_id: merchantAccountId,
      order_number: `OVC-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      order_state: opts.dimensions.orderState,
      ...(opts.shopId ? { shop_id: opts.shopId } : {}),
      total_amount: opts.totalAmount ?? 1000,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('order insert failed');
  return data.id;
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

type CountsRow = { count: number; view_id: string }[];

function countFor(rows: CountsRow, viewId: string): number {
  return rows.find((row) => row.view_id === viewId)?.count ?? 0;
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id);
  }
  createdUserIds.length = 0;
});

describe('get_order_view_counts (Lot 6, 0088)', () => {
  skipIfNoServiceRole('un ordre par vue d’état — chaque compteur = 1, toutes = 6', async () => {
    const { admin, email, merchantAccountId, userId } = await createOwnerFixture('per-view');
    const from = new Date(Date.now() - 10 * 86_400_000);
    const to = new Date(Date.now() + 86_400_000);
    const inWindow = new Date(Date.now() - 5 * 86_400_000).toISOString();

    await insertOrder(admin, merchantAccountId, {
      createdAt: inWindow,
      dimensions: { callState: 'to_call', deliveryState: 'unassigned', orderState: 'open' },
    });
    await insertOrder(admin, merchantAccountId, {
      createdAt: inWindow,
      dimensions: { callState: 'callback', deliveryState: 'unassigned', orderState: 'open' },
    });
    await insertOrder(admin, merchantAccountId, {
      createdAt: inWindow,
      dimensions: { callState: 'validated', deliveryState: 'assigned', orderState: 'open' },
    });
    const enLivraisonId = await insertOrder(admin, merchantAccountId, {
      createdAt: inWindow,
      dimensions: {
        callState: 'validated',
        deliveryState: 'out_for_delivery',
        orderState: 'open',
      },
    });
    await insertTransition(admin, merchantAccountId, userId, {
      createdAt: inWindow,
      orderId: enLivraisonId,
      toStatus: 'EN_LIVRAISON',
    });
    await insertOrder(admin, merchantAccountId, {
      createdAt: inWindow,
      dimensions: { callState: 'validated', deliveryState: 'delivered', orderState: 'completed' },
    });
    const annuleeId = await insertOrder(admin, merchantAccountId, {
      createdAt: inWindow,
      dimensions: { callState: 'validated', deliveryState: 'unassigned', orderState: 'cancelled' },
    });
    await insertTransition(admin, merchantAccountId, userId, {
      createdAt: inWindow,
      orderId: annuleeId,
      toStatus: 'ANNULEE',
    });

    const client = await signIn(email);
    const { data, error } = await client.rpc('get_order_view_counts', {
      p_from: from.toISOString(),
      p_merchant_id: merchantAccountId,
      p_to: to.toISOString(),
    });
    if (error) throw error;

    expect(countFor(data, 'toutes')).toBe(6);
    expect(countFor(data, 'a-appeler')).toBe(1);
    expect(countFor(data, 'tentee-a-rappeler')).toBe(1);
    expect(countFor(data, 'confirmee')).toBe(1);
    expect(countFor(data, 'en-livraison')).toBe(1);
    expect(countFor(data, 'valide')).toBe(1);
    expect(countFor(data, 'annulees-retours')).toBe(1);
  });

  skipIfNoServiceRole(
    'a-appeler filtre sur created_at, pas orderQueueDate (created_at_shopify hors fenêtre ignoré)',
    async () => {
      const { admin, email, merchantAccountId } = await createOwnerFixture('a-appeler-date');
      const from = new Date(Date.now() - 10 * 86_400_000);
      const to = new Date(Date.now() - 5 * 86_400_000);

      // created_at DANS la fenêtre, created_at_shopify très ancien (hors fenêtre) : doit
      // compter pour a-appeler (créneau sur created_at) même si orderQueueDate serait exclu.
      await insertOrder(admin, merchantAccountId, {
        createdAt: from.toISOString(),
        createdAtShopify: new Date(Date.now() - 365 * 86_400_000).toISOString(),
        dimensions: { callState: 'to_call', deliveryState: 'unassigned', orderState: 'open' },
      });

      const client = await signIn(email);
      const { data, error } = await client.rpc('get_order_view_counts', {
        p_from: from.toISOString(),
        p_merchant_id: merchantAccountId,
        p_to: to.toISOString(),
      });
      if (error) throw error;

      expect(countFor(data, 'a-appeler')).toBe(1);
    },
  );

  skipIfNoServiceRole(
    'TB-CPT en-livraison : état courant seul — une transition vieille de 20 jours (hors fenêtre 7j) compte quand même',
    async () => {
      const { admin, email, merchantAccountId, userId } =
        await createOwnerFixture('en-livraison-state-only');
      // Fenêtre 7j classique du Tableau : la transition ci-dessous est délibérément hors fenêtre.
      const from = new Date(Date.now() - 7 * 86_400_000);
      const to = new Date();
      const staleTransition = new Date(Date.now() - 20 * 86_400_000).toISOString();
      const recentTransition = new Date(Date.now() - 2 * 86_400_000).toISOString();

      // Rouge avant / vert après : état courant OK, transition vieille de 20 jours (hors
      // fenêtre p_from/p_to) — comptait 0 avant ce lot, doit compter 1 après.
      const staleId = await insertOrder(admin, merchantAccountId, {
        createdAt: staleTransition,
        dimensions: {
          callState: 'validated',
          deliveryState: 'out_for_delivery',
          orderState: 'open',
        },
      });
      await insertTransition(admin, merchantAccountId, userId, {
        createdAt: staleTransition,
        orderId: staleId,
        toStatus: 'EN_LIVRAISON',
      });

      // État courant OK, AUCUNE transition en base — doit aussi compter (matchesOrderSavedView
      // n'a jamais exigé de transition, seulement l'état courant).
      await insertOrder(admin, merchantAccountId, {
        createdAt: staleTransition,
        dimensions: {
          callState: 'validated',
          deliveryState: 'out_for_delivery',
          orderState: 'open',
        },
      });

      // Contrôle positif : transition récente, dans la fenêtre — reste comptée (un test qui ne
      // vérifie que le cas ancien serait vert même si le compteur retournait 0 ou n'importe quoi).
      const recentId = await insertOrder(admin, merchantAccountId, {
        createdAt: recentTransition,
        dimensions: {
          callState: 'validated',
          deliveryState: 'out_for_delivery',
          orderState: 'open',
        },
      });
      await insertTransition(admin, merchantAccountId, userId, {
        createdAt: recentTransition,
        orderId: recentId,
        toStatus: 'EN_LIVRAISON',
      });

      // Transition qualifiante mais état courant a changé depuis (livrée) → exclu : l'état
      // courant reste la condition, seule la fenêtre de transition disparaît.
      const deliveredId = await insertOrder(admin, merchantAccountId, {
        createdAt: staleTransition,
        dimensions: { callState: 'validated', deliveryState: 'delivered', orderState: 'completed' },
      });
      await insertTransition(admin, merchantAccountId, userId, {
        createdAt: staleTransition,
        orderId: deliveredId,
        toStatus: 'EN_LIVRAISON',
      });

      const client = await signIn(email);
      const { data, error } = await client.rpc('get_order_view_counts', {
        p_from: from.toISOString(),
        p_merchant_id: merchantAccountId,
        p_to: to.toISOString(),
      });
      if (error) throw error;

      expect(countFor(data, 'en-livraison')).toBe(3);
    },
  );

  skipIfNoServiceRole(
    'TB-CPT annulees-retours : état courant seul — une transition vieille de 20 jours compte quand même',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture(
        'annulees-retours-state-only',
      );
      const from = new Date(Date.now() - 7 * 86_400_000);
      const to = new Date();
      const staleTransition = new Date(Date.now() - 20 * 86_400_000).toISOString();
      const recentTransition = new Date(Date.now() - 2 * 86_400_000).toISOString();

      // Rouge avant / vert après.
      const staleCancelled = await insertOrder(admin, merchantAccountId, {
        createdAt: staleTransition,
        dimensions: {
          callState: 'validated',
          deliveryState: 'unassigned',
          orderState: 'cancelled',
        },
      });
      await insertTransition(admin, merchantAccountId, userId, {
        createdAt: staleTransition,
        orderId: staleCancelled,
        toStatus: 'ANNULEE',
      });

      // `returned` (pas seulement `cancelled`) compte aussi, sans transition en base.
      await insertOrder(admin, merchantAccountId, {
        createdAt: staleTransition,
        dimensions: { callState: 'validated', deliveryState: 'unassigned', orderState: 'returned' },
      });

      // Contrôle positif.
      const recentRefused = await insertOrder(admin, merchantAccountId, {
        createdAt: recentTransition,
        dimensions: {
          callState: 'validated',
          deliveryState: 'unassigned',
          orderState: 'cancelled',
        },
      });
      await insertTransition(admin, merchantAccountId, userId, {
        createdAt: recentTransition,
        orderId: recentRefused,
        toStatus: 'REFUSEE',
      });

      // État courant changé depuis (revenu open) → exclu.
      const reopened = await insertOrder(admin, merchantAccountId, {
        createdAt: staleTransition,
        dimensions: { callState: 'to_call', deliveryState: 'unassigned', orderState: 'open' },
      });
      await insertTransition(admin, merchantAccountId, userId, {
        createdAt: staleTransition,
        orderId: reopened,
        toStatus: 'ANNULEE',
      });

      const client = await signIn(email);
      const { data, error } = await client.rpc('get_order_view_counts', {
        p_from: from.toISOString(),
        p_merchant_id: merchantAccountId,
        p_to: to.toISOString(),
      });
      if (error) throw error;

      expect(countFor(data, 'annulees-retours')).toBe(3);
    },
  );

  skipIfNoServiceRole(
    'scope boutique optionnel : exclut les commandes des autres boutiques',
    async () => {
      const { admin, email, merchantAccountId } = await createOwnerFixture('shop-scope');
      const shopA = await createShop(admin, merchantAccountId);
      const shopB = await createShop(admin, merchantAccountId);
      const from = new Date(Date.now() - 10 * 86_400_000);
      const to = new Date(Date.now() + 86_400_000);

      await insertOrder(admin, merchantAccountId, {
        dimensions: { callState: 'to_call', deliveryState: 'unassigned', orderState: 'open' },
        shopId: shopA,
      });
      await insertOrder(admin, merchantAccountId, {
        dimensions: { callState: 'to_call', deliveryState: 'unassigned', orderState: 'open' },
        shopId: shopB,
      });

      const client = await signIn(email);
      const { data, error } = await client.rpc('get_order_view_counts', {
        p_from: from.toISOString(),
        p_merchant_id: merchantAccountId,
        p_shop_id: shopA,
        p_to: to.toISOString(),
      });
      if (error) throw error;

      expect(countFor(data, 'toutes')).toBe(1);
      expect(countFor(data, 'a-appeler')).toBe(1);
    },
  );

  skipIfNoServiceRole(
    'bornes de fenêtre INCLUSIVES aux deux extrémités, commande hors fenêtre exclue',
    async () => {
      const { admin, email, merchantAccountId } = await createOwnerFixture('window-bounds');
      const from = new Date(Date.now() - 10 * 86_400_000);
      const to = new Date(Date.now() - 5 * 86_400_000);

      await insertOrder(admin, merchantAccountId, {
        createdAt: from.toISOString(),
        dimensions: { callState: 'validated', deliveryState: 'unassigned', orderState: 'open' },
      });
      await insertOrder(admin, merchantAccountId, {
        createdAt: to.toISOString(),
        dimensions: { callState: 'validated', deliveryState: 'unassigned', orderState: 'open' },
      });
      await insertOrder(admin, merchantAccountId, {
        createdAt: new Date(Date.now() - 1 * 86_400_000).toISOString(), // après `to`
        dimensions: { callState: 'validated', deliveryState: 'unassigned', orderState: 'open' },
      });

      const client = await signIn(email);
      const { data, error } = await client.rpc('get_order_view_counts', {
        p_from: from.toISOString(),
        p_merchant_id: merchantAccountId,
        p_to: to.toISOString(),
      });
      if (error) throw error;

      expect(countFor(data, 'confirmee')).toBe(2);
      expect(countFor(data, 'toutes')).toBe(2);
    },
  );

  skipIfNoServiceRole(
    'agent : mêmes compteurs que owner (aucune restriction de rôle)',
    async () => {
      const { admin, merchantAccountId } = await createOwnerFixture('agent-parity');
      const from = new Date(Date.now() - 10 * 86_400_000);
      const to = new Date(Date.now() + 86_400_000);

      await insertOrder(admin, merchantAccountId, {
        dimensions: { callState: 'to_call', deliveryState: 'unassigned', orderState: 'open' },
      });

      const { email: agentEmail } = await addMember(admin, merchantAccountId, 'agent');
      const client = await signIn(agentEmail);
      const { data, error } = await client.rpc('get_order_view_counts', {
        p_from: from.toISOString(),
        p_merchant_id: merchantAccountId,
        p_to: to.toISOString(),
      });
      if (error) throw error;

      expect(countFor(data, 'a-appeler')).toBe(1);
      expect(countFor(data, 'toutes')).toBe(1);
    },
  );

  skipIfNoServiceRole(
    'isolation tenant : owner du tenant B lisant le merchant_id du tenant A obtient des compteurs à 0 (RLS, pas une erreur)',
    async () => {
      const { admin, merchantAccountId: merchantA } = await createOwnerFixture('tenant-a');
      await insertOrder(admin, merchantA, {
        dimensions: { callState: 'to_call', deliveryState: 'unassigned', orderState: 'open' },
      });
      const { email: emailB } = await createOwnerFixture('tenant-b');
      const clientB = await signIn(emailB);

      const { data, error } = await clientB.rpc('get_order_view_counts', {
        p_from: new Date(Date.now() - 30 * 86_400_000).toISOString(),
        p_merchant_id: merchantA,
        p_to: new Date(Date.now() + 86_400_000).toISOString(),
      });
      if (error) throw error;

      expect((data ?? []).every((row) => row.count === 0)).toBe(true);
    },
  );
});
