import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

// get_dashboard_priority_counts (0081, redéfinie 4-args par 0082) — Tableau, bloc « Priorités
// à traiter ». Aucun test dédié n'existait avant TB-CPT (0149).
//
// TB-CPT (migration 0149) — en_livraison/annulees_retours exigeaient une transition dans la
// fenêtre p_since/p_until EN PLUS de l'état courant : une commande dans l'état visé depuis plus
// de 7 jours n'était jamais comptée — mesuré en production (24→4, 130→9 selon la vue). Corrigé :
// état courant SEUL, aligné sur matchesOrderSavedView (lib/domain/order-saved-views.ts,
// consommée par la vue de drill-down /commandes?vue=en-livraison|annulees-retours).
// a_appeler (created_at dans la fenêtre 7j) et a_rappeler (déjà sans date depuis 0082, issue
// #58) sont hors périmètre de ce lot — non-régression vérifiée ci-dessous.

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'dashboard-priority-counts-rls-pw';
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
  const email = `dashboard-priority-counts-${label}-${Date.now()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  return { admin, email, merchantAccountId, userId };
}

type Dimensions = {
  callState: string;
  deliveryState: string;
  orderState: string;
};

const DISPATCH_DELIVERY_STATES = new Set(['assigned', 'out_for_delivery']);

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

async function insertOrder(
  admin: AdminClient,
  merchantAccountId: string,
  opts: {
    assignedDriverId?: string | null;
    codStatus?: string | null;
    createdAt?: string;
    dimensions: Dimensions;
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
      created_at_shopify: createdAt,
      currency: 'XOF',
      delivery_state: opts.dimensions.deliveryState,
      merchant_account_id: merchantAccountId,
      order_number: `DPC-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      order_state: opts.dimensions.orderState,
      total_amount: opts.totalAmount ?? 1000,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('order insert failed');
  return data.id as string;
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

type PriorityCounts = {
  a_appeler: number;
  a_rappeler: number;
  annulees_retours: number;
  en_livraison: number;
};

async function fetchCounts(
  client: SupabaseClient<Database>,
  args: { merchantAccountId: string; since: string; until: string },
): Promise<PriorityCounts> {
  const { data, error } = await client.rpc('get_dashboard_priority_counts', {
    p_merchant_id: args.merchantAccountId,
    p_since: args.since,
    p_until: args.until,
  });
  if (error) throw error;
  return data as unknown as PriorityCounts;
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id);
  }
  createdUserIds.length = 0;
});

describe('get_dashboard_priority_counts (0081/0082, TB-CPT 0149)', () => {
  skipIfNoServiceRole(
    'TB-CPT en_livraison : état courant seul — une transition vieille de 20 jours (hors fenêtre 7j) compte quand même',
    async () => {
      const { admin, email, merchantAccountId, userId } =
        await createOwnerFixture('en-livraison-state-only');
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const until = new Date().toISOString();
      const staleTransition = new Date(Date.now() - 20 * 86_400_000).toISOString();
      const recentTransition = new Date(Date.now() - 2 * 86_400_000).toISOString();

      // Rouge avant / vert après : comptait 0 avant ce lot (transition hors fenêtre p_since/
      // p_until), doit compter 1 après.
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

      // État courant OK, aucune transition en base — compte aussi (matchesOrderSavedView
      // n'exige jamais de transition, seulement l'état courant).
      await insertOrder(admin, merchantAccountId, {
        createdAt: staleTransition,
        dimensions: {
          callState: 'validated',
          deliveryState: 'out_for_delivery',
          orderState: 'open',
        },
      });

      // Contrôle positif : transition récente, dans la fenêtre — reste comptée.
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

      // Transition qualifiante mais état courant changé depuis (livrée) → exclu.
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
      const counts = await fetchCounts(client, { merchantAccountId, since, until });

      expect(counts.en_livraison).toBe(3);
    },
  );

  skipIfNoServiceRole(
    'TB-CPT annulees_retours : état courant seul — une transition vieille de 20 jours compte quand même',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture(
        'annulees-retours-state-only',
      );
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const until = new Date().toISOString();
      const staleTransition = new Date(Date.now() - 20 * 86_400_000).toISOString();
      const recentTransition = new Date(Date.now() - 2 * 86_400_000).toISOString();

      // Rouge avant / vert après.
      const staleId = await insertOrder(admin, merchantAccountId, {
        createdAt: staleTransition,
        dimensions: {
          callState: 'validated',
          deliveryState: 'unassigned',
          orderState: 'cancelled',
        },
      });
      await insertTransition(admin, merchantAccountId, userId, {
        createdAt: staleTransition,
        orderId: staleId,
        toStatus: 'ANNULEE',
      });

      // `returned` compte aussi, sans transition en base.
      await insertOrder(admin, merchantAccountId, {
        createdAt: staleTransition,
        dimensions: { callState: 'validated', deliveryState: 'unassigned', orderState: 'returned' },
      });

      // Contrôle positif.
      const recentId = await insertOrder(admin, merchantAccountId, {
        createdAt: recentTransition,
        dimensions: {
          callState: 'validated',
          deliveryState: 'unassigned',
          orderState: 'cancelled',
        },
      });
      await insertTransition(admin, merchantAccountId, userId, {
        createdAt: recentTransition,
        orderId: recentId,
        toStatus: 'REFUSEE',
      });

      // État courant revenu open → exclu.
      const reopenedId = await insertOrder(admin, merchantAccountId, {
        createdAt: staleTransition,
        dimensions: { callState: 'to_call', deliveryState: 'unassigned', orderState: 'open' },
      });
      await insertTransition(admin, merchantAccountId, userId, {
        createdAt: staleTransition,
        orderId: reopenedId,
        toStatus: 'ANNULEE',
      });

      const client = await signIn(email);
      const counts = await fetchCounts(client, { merchantAccountId, since, until });

      expect(counts.annulees_retours).toBe(3);
    },
  );

  skipIfNoServiceRole(
    'non-régression : a_appeler (fenêtre created_at 7j) et a_rappeler (sans date, 0082) inchangés par TB-CPT',
    async () => {
      const { admin, email, merchantAccountId } = await createOwnerFixture('non-regression');
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const until = new Date().toISOString();
      const inWindow = new Date(Date.now() - 3 * 86_400_000).toISOString();
      const oldCreatedAt = new Date(Date.now() - 30 * 86_400_000).toISOString();

      // a_appeler : dans la fenêtre 7j sur created_at → compté.
      await insertOrder(admin, merchantAccountId, {
        createdAt: inWindow,
        dimensions: { callState: 'to_call', deliveryState: 'unassigned', orderState: 'open' },
      });
      // a_appeler : créée il y a 30 jours, hors fenêtre → non comptée (comportement inchangé,
      // hors périmètre TB-CPT — seuls en_livraison/annulees_retours perdent leur fenêtre).
      await insertOrder(admin, merchantAccountId, {
        createdAt: oldCreatedAt,
        dimensions: { callState: 'to_call', deliveryState: 'unassigned', orderState: 'open' },
      });

      // a_rappeler : ancienne (30j), sans filtre de date depuis 0082 → comptée malgré tout.
      await insertOrder(admin, merchantAccountId, {
        createdAt: oldCreatedAt,
        dimensions: { callState: 'callback', deliveryState: 'unassigned', orderState: 'open' },
      });

      const client = await signIn(email);
      const counts = await fetchCounts(client, { merchantAccountId, since, until });

      expect(counts.a_appeler).toBe(1);
      expect(counts.a_rappeler).toBe(1);
    },
  );

  skipIfNoServiceRole(
    'isolation tenant : merchant_id étranger renvoie des compteurs à 0',
    async () => {
      const { admin, merchantAccountId: merchantA, userId } = await createOwnerFixture('tenant-a');
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const until = new Date().toISOString();
      const oldTransition = new Date(Date.now() - 20 * 86_400_000).toISOString();

      const orderId = await insertOrder(admin, merchantA, {
        createdAt: oldTransition,
        dimensions: {
          callState: 'validated',
          deliveryState: 'out_for_delivery',
          orderState: 'open',
        },
      });
      await insertTransition(admin, merchantA, userId, {
        createdAt: oldTransition,
        orderId,
        toStatus: 'EN_LIVRAISON',
      });

      const { email: emailB } = await createOwnerFixture('tenant-b');
      const clientB = await signIn(emailB);
      const counts = await fetchCounts(clientB, { merchantAccountId: merchantA, since, until });

      expect(counts.a_appeler).toBe(0);
      expect(counts.a_rappeler).toBe(0);
      expect(counts.en_livraison).toBe(0);
      expect(counts.annulees_retours).toBe(0);
    },
  );
});
