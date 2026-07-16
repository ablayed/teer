import { orderStatuses } from '@/lib/domain/order-state-machine';
import { legacyStatusToDimensions } from '@/lib/domain/order-transition-actions';
import { matchesOrderSearch } from '@/lib/orders/search';
import type { Database } from '@/lib/supabase/database.types';
import {
  type PostgrestError,
  type PostgrestSingleResponse,
  type SupabaseClient,
  createClient,
} from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'mot-de-passe-phase1-rls';
const createdUserIds: string[] = [];

type AdminClient = SupabaseClient<Database>;

type TransitionOrderArgs = {
  p_actor: string;
  p_assigned_driver_id?: string;
  p_attempt_count?: number;
  p_call_state?: string;
  p_cancel_reason?: string;
  p_cash_state?: string;
  p_clear_scheduled_for?: boolean;
  p_delivery_state?: string;
  p_next_contact_at?: string;
  p_note?: string;
  p_order_id: string;
  p_order_state?: string;
  p_payment_channel?: string;
  p_scheduled_for?: string;
};

type ReconcileRow = {
  derived_cod_status: string;
  merchant_account_id: string;
  order_id: string;
  stored_cod_status: string;
};

type SearchVisibleOrder = {
  customer: {
    full_name: string | null;
    phone: string | null;
  } | null;
  id: string;
  items_summary: Database['public']['Tables']['orders']['Row']['items_summary'];
  order_number: string | null;
};

function adminClient(): AdminClient {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function transitionOrderRpc(client: SupabaseClient<Database>) {
  return client.rpc.bind(client) as unknown as (
    fn: 'transition_order',
    args: TransitionOrderArgs,
  ) => Promise<PostgrestSingleResponse<string>>;
}

function reconcileCodStatusRpc(client: SupabaseClient<Database>) {
  return client.rpc.bind(client) as unknown as (
    fn: 'reconcile_order_cod_status',
    args?: Record<string, never>,
  ) => Promise<{ data: ReconcileRow[] | null; error: PostgrestError | null }>;
}

async function createConfirmedUser(admin: AdminClient, email: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error || !data.user) {
    throw error ?? new Error('Utilisateur de test non cree');
  }

  createdUserIds.push(data.user.id);
  return data.user.id;
}

async function waitForMerchantAccount(admin: AdminClient, userId: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { data, error } = await admin
      .from('merchant_account')
      .select('id')
      .eq('owner_user_id', userId)
      .limit(1)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (data?.id) {
      return data.id;
    }
  }

  throw new Error('Merchant account introuvable');
}

async function createOwnerFixture(label: string) {
  const admin = adminClient();
  const email = `phase1-rls-${label}-${Date.now()}-${crypto.randomUUID()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);

  return { admin, email, merchantAccountId, userId };
}

async function addMember(
  admin: AdminClient,
  merchantAccountId: string,
  role: 'agent' | 'manager' | 'owner',
) {
  const email = `phase1-member-${role}-${Date.now()}-${crypto.randomUUID()}@example.com`;
  const userId = await createConfirmedUser(admin, email);

  await admin.from('merchant_account').delete().eq('owner_user_id', userId);

  const { error } = await admin.from('merchant_member').insert({
    merchant_account_id: merchantAccountId,
    role,
    user_id: userId,
  });

  if (error) {
    throw error;
  }

  return { email, userId };
}

async function signIn(email: string) {
  const client = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });

  if (error) {
    throw error;
  }

  return client;
}

async function createOrder(
  admin: AdminClient,
  merchantAccountId: string,
  status: (typeof orderStatuses)[number],
) {
  const dimensions = legacyStatusToDimensions(status);
  // Contrainte 0057 : un statut dispatché (assigned/out_for_delivery) exige un livreur.
  // legacyStatusToDimensions renvoie un driver null pour EN_LIVRAISON → on en crée un.
  const needsDriver =
    dimensions.deliveryState === 'assigned' || dimensions.deliveryState === 'out_for_delivery';
  const assignedDriverId = needsDriver
    ? await createDriver(admin, merchantAccountId)
    : dimensions.assignedDriverId;
  const { data, error } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      order_number: `PHASE1-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      total_amount: 10000,
      currency: 'XOF',
      cod_status: status,
      order_state: dimensions.orderState,
      call_state: dimensions.callState,
      delivery_state: dimensions.deliveryState,
      cash_state: dimensions.cashState,
      attempt_count: dimensions.attemptCount,
      next_contact_at: dimensions.nextContactAt,
      scheduled_for: dimensions.scheduledFor,
      cancel_reason: dimensions.cancelReason,
      assigned_driver_id: assignedDriverId,
      created_at_shopify: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error || !data) {
    throw error ?? new Error('Commande de test non creee');
  }

  return data.id;
}

async function createDriver(admin: AdminClient, merchantAccountId: string) {
  const { data, error } = await admin
    .from('driver')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: `Livreur-${Date.now()}`,
      phone: `+22177${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
    })
    .select('id')
    .single();

  if (error || !data) {
    throw error ?? new Error('Livreur de test non cree');
  }

  return data.id;
}

afterEach(async () => {
  if (!supabaseUrl || !serviceRoleKey) {
    return;
  }

  const admin = adminClient();
  await Promise.all(createdUserIds.map((userId) => admin.auth.admin.deleteUser(userId)));
  createdUserIds.length = 0;
});

describe('orders dimensions RLS', () => {
  it.skipIf(!supabaseUrl || !serviceRoleKey || !anonKey)(
    'isole les nouvelles colonnes de dimensions entre tenants',
    async () => {
      const fixtureA = await createOwnerFixture('tenant-a');
      const fixtureB = await createOwnerFixture('tenant-b');
      const orderId = await createOrder(fixtureA.admin, fixtureA.merchantAccountId, 'A_APPELER');
      const outsider = await signIn(fixtureB.email);

      const { data: hiddenRows, error: hiddenError } = await outsider
        .from('orders')
        .select('id, order_state, call_state, delivery_state, cash_state')
        .eq('id', orderId);

      expect(hiddenError).toBeNull();
      expect(hiddenRows).toEqual([]);

      const { error: updateError } = await outsider
        .from('orders')
        .update({ order_state: 'completed' })
        .eq('id', orderId);

      expect(updateError).toBeNull();

      const { data: storedOrder, error: storedOrderError } = await fixtureA.admin
        .from('orders')
        .select('order_state, call_state, delivery_state, cash_state')
        .eq('id', orderId)
        .single();

      expect(storedOrderError).toBeNull();
      expect(storedOrder).toMatchObject({
        order_state: 'open',
        call_state: 'to_call',
        delivery_state: 'unassigned',
        cash_state: 'not_due',
      });
    },
  );

  it.skipIf(!supabaseUrl || !serviceRoleKey || !anonKey)(
    'respecte le WITH CHECK agent sur le cod_status derive par le trigger',
    async () => {
      const fixture = await createOwnerFixture('agent-check');
      const agent = await addMember(fixture.admin, fixture.merchantAccountId, 'agent');
      const orderId = await createOrder(fixture.admin, fixture.merchantAccountId, 'CONFIRMEE');
      const driverId = await createDriver(fixture.admin, fixture.merchantAccountId);
      const agentClient = await signIn(agent.email);

      const programmed = await transitionOrderRpc(agentClient)('transition_order', {
        p_actor: agent.userId,
        p_call_state: 'validated',
        p_cash_state: 'expected',
        p_delivery_state: 'scheduled',
        p_order_id: orderId,
      });

      expect(programmed.error).toBeNull();
      expect(programmed.data).toBe('PROGRAMMEE');

      const assigned = await transitionOrderRpc(agentClient)('transition_order', {
        p_actor: agent.userId,
        p_call_state: 'validated',
        p_cash_state: 'expected',
        p_delivery_state: 'assigned',
        p_assigned_driver_id: driverId,
        p_order_id: orderId,
      });

      expect(assigned.error).toBeNull();
      expect(assigned.data).toBe('EN_LIVRAISON');

      const delivered = await transitionOrderRpc(agentClient)('transition_order', {
        p_actor: agent.userId,
        p_call_state: 'validated',
        p_cash_state: 'collected',
        p_delivery_state: 'delivered',
        p_order_id: orderId,
        p_order_state: 'completed',
        p_payment_channel: 'ESPECES',
      });

      expect(delivered.error).not.toBeNull();

      const { data: storedOrder, error: storedOrderError } = await fixture.admin
        .from('orders')
        .select('cod_status, order_state, delivery_state, cash_state')
        .eq('id', orderId)
        .single();

      expect(storedOrderError).toBeNull();
      expect(storedOrder).toMatchObject({
        cod_status: 'EN_LIVRAISON',
        order_state: 'open',
        delivery_state: 'assigned',
        cash_state: 'expected',
      });
    },
  );

  it.skipIf(!supabaseUrl || !serviceRoleKey)(
    'interdit delivery_state assigned/out_for_delivery sans livreur (contrainte 0057)',
    async () => {
      const fixture = await createOwnerFixture('dispatch-driver');
      // CONFIRMEE → delivery_state=unassigned, assigned_driver_id=null.
      const orderId = await createOrder(fixture.admin, fixture.merchantAccountId, 'CONFIRMEE');

      // Service-role contourne RLS mais PAS le CHECK : dispatch sans livreur rejete.
      const orphanAssigned = await fixture.admin
        .from('orders')
        .update({ delivery_state: 'assigned' })
        .eq('id', orderId);
      expect(orphanAssigned.error).not.toBeNull();

      const orphanOfd = await fixture.admin
        .from('orders')
        .update({ delivery_state: 'out_for_delivery' })
        .eq('id', orderId);
      expect(orphanOfd.error).not.toBeNull();

      // La commande est restee unassigned (aucune ecriture orpheline).
      const { data: untouched } = await fixture.admin
        .from('orders')
        .select('delivery_state, assigned_driver_id')
        .eq('id', orderId)
        .single();
      expect(untouched).toMatchObject({ delivery_state: 'unassigned', assigned_driver_id: null });

      // Avec un livreur effectif → dispatch autorise.
      const driverId = await createDriver(fixture.admin, fixture.merchantAccountId);
      const dispatched = await fixture.admin
        .from('orders')
        .update({ delivery_state: 'assigned', assigned_driver_id: driverId })
        .eq('id', orderId);
      expect(dispatched.error).toBeNull();
    },
  );

  it.skipIf(!supabaseUrl || !serviceRoleKey)(
    'retourne zero ecart dans la reconciliation des statuts legacy',
    async () => {
      const fixture = await createOwnerFixture('reconcile');

      for (const status of orderStatuses) {
        await createOrder(fixture.admin, fixture.merchantAccountId, status);
      }

      const result = await reconcileCodStatusRpc(fixture.admin)('reconcile_order_cod_status', {});

      expect(result.error).toBeNull();
      expect(result.data ?? []).toEqual([]);
    },
  );

  it.skipIf(!supabaseUrl || !serviceRoleKey || !anonKey)(
    'autorise l agent a creer une commande manuelle sur son tenant uniquement',
    async () => {
      const fixtureA = await createOwnerFixture('manual-own-tenant');
      const fixtureB = await createOwnerFixture('manual-other-tenant');
      const agent = await addMember(fixtureA.admin, fixtureA.merchantAccountId, 'agent');
      const agentClient = await signIn(agent.email);

      const { data: customer, error: customerError } = await agentClient
        .from('customer')
        .insert({
          merchant_account_id: fixtureA.merchantAccountId,
          full_name: 'Client manuel',
          phone: '+221771010101',
        })
        .select('id')
        .single();

      expect(customerError).toBeNull();
      expect(customer?.id).toBeTruthy();

      const ownInsert = await agentClient
        .from('orders')
        .insert({
          merchant_account_id: fixtureA.merchantAccountId,
          customer_id: customer?.id ?? null,
          shopify_order_id: null,
          source: 'manual',
          order_number: `MAN-RLS-${Date.now()}`,
          total_amount: 12000,
          currency: 'XOF',
          items_summary: [{ title: 'Produit manuel', quantity: 1, price: 12000 }],
          order_state: 'open',
          call_state: 'to_call',
          delivery_state: 'unassigned',
          cash_state: 'not_due',
        })
        .select('id, cod_status, source')
        .single();

      expect(ownInsert.error).toBeNull();
      expect(ownInsert.data).toMatchObject({
        cod_status: 'A_APPELER',
        source: 'manual',
      });

      const foreignOrderNumber = `MAN-RLS-FOREIGN-${Date.now()}`;
      const foreignInsert = await agentClient.from('orders').insert({
        merchant_account_id: fixtureB.merchantAccountId,
        customer_id: null,
        shopify_order_id: null,
        source: 'manual',
        order_number: foreignOrderNumber,
        total_amount: 15000,
        currency: 'XOF',
        items_summary: [{ title: 'Produit interdit', quantity: 1, price: 15000 }],
        order_state: 'open',
        call_state: 'to_call',
        delivery_state: 'unassigned',
        cash_state: 'not_due',
      });

      expect(foreignInsert.error).not.toBeNull();

      const { data: foreignRows, error: foreignRowsError } = await fixtureB.admin
        .from('orders')
        .select('id')
        .eq('order_number', foreignOrderNumber);

      expect(foreignRowsError).toBeNull();
      expect(foreignRows ?? []).toEqual([]);
    },
  );

  it.skipIf(!supabaseUrl || !serviceRoleKey || !anonKey)(
    'isole la reservation des numeros manuels et interdit l acces direct au compteur',
    async () => {
      const fixtureA = await createOwnerFixture('manual-counter-a');
      const fixtureB = await createOwnerFixture('manual-counter-b');
      const ownerA = await signIn(fixtureA.email);
      const ownerB = await signIn(fixtureB.email);
      const firstA = await ownerA.rpc('reserve_manual_order_number', {
        p_merchant_account_id: fixtureA.merchantAccountId,
      });
      expect(firstA.error).toBeNull();
      expect(firstA.data).toBe('M-1');

      // Un owner du marchand A ne peut ni lire ni avancer le compteur du marchand B.
      const forbiddenB = await ownerA.rpc('reserve_manual_order_number', {
        p_merchant_account_id: fixtureB.merchantAccountId,
      });
      expect(forbiddenB.data).toBeNull();
      expect(forbiddenB.error).not.toBeNull();

      // B démarre donc à M-1 : l'appel refusé de A n'a eu aucun effet de bord cross-tenant.
      const firstB = await ownerB.rpc('reserve_manual_order_number', {
        p_merchant_account_id: fixtureB.merchantAccountId,
      });
      expect(firstB.error).toBeNull();
      expect(firstB.data).toBe('M-1');

      const secondA = await ownerA.rpc('reserve_manual_order_number', {
        p_merchant_account_id: fixtureA.merchantAccountId,
      });
      expect(secondA.error).toBeNull();
      expect(secondA.data).toBe('M-2');

      const concurrentReservations = await Promise.all([
        ownerA.rpc('reserve_manual_order_number', {
          p_merchant_account_id: fixtureA.merchantAccountId,
        }),
        ownerA.rpc('reserve_manual_order_number', {
          p_merchant_account_id: fixtureA.merchantAccountId,
        }),
      ]);
      expect(concurrentReservations.map((result) => result.error)).toEqual([null, null]);
      expect(concurrentReservations.map((result) => result.data).sort()).toEqual(['M-3', 'M-4']);

      const directRead = await ownerA.from('manual_order_number_counter').select('*');
      const directWrite = await ownerA.from('manual_order_number_counter').insert({
        merchant_account_id: fixtureA.merchantAccountId,
        next_value: 999,
      });

      expect(directRead.error).not.toBeNull();
      expect(directWrite.error).not.toBeNull();
    },
  );

  it.skipIf(!supabaseUrl || !serviceRoleKey || !anonKey)(
    'garde la recherche isolee par tenant sur le dataset visible',
    async () => {
      const fixtureA = await createOwnerFixture('search-a');
      const fixtureB = await createOwnerFixture('search-b');

      await fixtureA.admin.from('customer').insert({
        merchant_account_id: fixtureA.merchantAccountId,
        full_name: 'Awa Recherche',
        phone: '+221771020202',
      });

      const { data: customerB } = await fixtureB.admin
        .from('customer')
        .insert({
          merchant_account_id: fixtureB.merchantAccountId,
          full_name: 'Moussa Visible',
          phone: '+221781030303',
        })
        .select('id')
        .single();

      await fixtureA.admin.from('orders').insert({
        merchant_account_id: fixtureA.merchantAccountId,
        shopify_order_id: null,
        source: 'manual',
        order_number: `SEA-${Date.now()}`,
        total_amount: 10000,
        currency: 'XOF',
        items_summary: [{ title: 'Produit Rare A', quantity: 1, price: 10000 }],
        order_state: 'open',
        call_state: 'to_call',
        delivery_state: 'unassigned',
        cash_state: 'not_due',
      });

      await fixtureB.admin.from('orders').insert({
        merchant_account_id: fixtureB.merchantAccountId,
        customer_id: customerB?.id ?? null,
        shopify_order_id: null,
        source: 'manual',
        order_number: `SEB-${Date.now()}`,
        total_amount: 10000,
        currency: 'XOF',
        items_summary: [{ title: 'Produit Visible B', quantity: 1, price: 10000 }],
        order_state: 'open',
        call_state: 'to_call',
        delivery_state: 'unassigned',
        cash_state: 'not_due',
      });

      const outsider = await signIn(fixtureB.email);
      const { data, error } = await outsider
        .from('orders')
        .select('id, order_number, items_summary, customer:customer_id(full_name, phone)');

      expect(error).toBeNull();

      const visibleRows = (data ?? []) as SearchVisibleOrder[];
      const foreignMatches = visibleRows.filter((order) =>
        matchesOrderSearch(order, 'Produit Rare A'),
      );
      const ownMatches = visibleRows.filter((order) =>
        matchesOrderSearch(order, 'Produit Visible B'),
      );

      expect(foreignMatches).toEqual([]);
      expect(ownMatches).toHaveLength(1);
    },
  );
});

// Migration 0096 — cash_collected_at doit prendre scheduled_for quand renseigné, jamais
// now() seul, pour les commandes livrées. Exerce le VRAI chemin transition_order (RPC),
// jamais un insert direct dans orders — la garde d'idempotence et le fallback now() ne
// peuvent être prouvés qu'en rejouant le moteur.
describe('transition_order — cash_collected_at daté sur scheduled_for (migration 0096)', () => {
  it.skipIf(!supabaseUrl || !serviceRoleKey || !anonKey)(
    'commande programmée puis livrée en retard : cash_collected_at = scheduled_for, pas now()',
    async () => {
      const fixture = await createOwnerFixture('cca-scheduled');
      const orderId = await createOrder(fixture.admin, fixture.merchantAccountId, 'CONFIRMEE');
      const owner = await signIn(fixture.email);
      // scheduled_for dans le passé (3 jours) : simule une livraison saisie en retard.
      const scheduledFor = new Date(Date.now() - 3 * 86_400_000).toISOString();

      const programmed = await transitionOrderRpc(owner)('transition_order', {
        p_actor: fixture.userId,
        p_call_state: 'validated',
        p_cash_state: 'expected',
        p_delivery_state: 'scheduled',
        p_order_id: orderId,
        p_scheduled_for: scheduledFor,
      });
      expect(programmed.error).toBeNull();
      expect(programmed.data).toBe('PROGRAMMEE');

      const delivered = await transitionOrderRpc(owner)('transition_order', {
        p_actor: fixture.userId,
        p_call_state: 'validated',
        p_cash_state: 'collected',
        p_delivery_state: 'delivered',
        p_order_id: orderId,
        p_order_state: 'completed',
        p_payment_channel: 'ESPECES',
      });
      expect(delivered.error).toBeNull();
      expect(delivered.data).toBe('LIVREE');

      const { data: stored, error: storedError } = await fixture.admin
        .from('orders')
        .select('cash_collected_at')
        .eq('id', orderId)
        .single();
      expect(storedError).toBeNull();
      expect(stored?.cash_collected_at).not.toBeNull();
      const collectedAtMs = new Date(stored?.cash_collected_at as string).getTime();
      expect(collectedAtMs).toBe(new Date(scheduledFor).getTime());
    },
  );

  it.skipIf(!supabaseUrl || !serviceRoleKey || !anonKey)(
    'commande jamais programmée (scheduled_for null) : cash_collected_at reste now() au clic',
    async () => {
      const fixture = await createOwnerFixture('cca-fallback');
      const orderId = await createOrder(fixture.admin, fixture.merchantAccountId, 'CONFIRMEE');
      const owner = await signIn(fixture.email);

      const before = Date.now();
      const delivered = await transitionOrderRpc(owner)('transition_order', {
        p_actor: fixture.userId,
        p_call_state: 'validated',
        p_cash_state: 'collected',
        p_delivery_state: 'delivered',
        p_order_id: orderId,
        p_order_state: 'completed',
        p_payment_channel: 'ESPECES',
      });
      const after = Date.now();
      expect(delivered.error).toBeNull();
      expect(delivered.data).toBe('LIVREE');

      const { data: stored, error: storedError } = await fixture.admin
        .from('orders')
        .select('cash_collected_at, scheduled_for')
        .eq('id', orderId)
        .single();
      expect(storedError).toBeNull();
      expect(stored?.scheduled_for).toBeNull();
      expect(stored?.cash_collected_at).not.toBeNull();
      // Fenêtre before/after plutôt qu'une égalité exacte à now() — évite tout flake
      // d'horloge entre l'appel RPC et cette assertion (garde-fou porteur).
      const collectedAtMs = new Date(stored?.cash_collected_at as string).getTime();
      expect(collectedAtMs).toBeGreaterThanOrEqual(before);
      expect(collectedAtMs).toBeLessThanOrEqual(after);
    },
  );

  it.skipIf(!supabaseUrl || !serviceRoleKey || !anonKey)(
    'idempotence : un second passage sur une commande déjà livrée ne réécrase jamais cash_collected_at',
    async () => {
      const fixture = await createOwnerFixture('cca-idempotent');
      const orderId = await createOrder(fixture.admin, fixture.merchantAccountId, 'CONFIRMEE');
      const owner = await signIn(fixture.email);
      const scheduledFor = new Date(Date.now() - 1 * 86_400_000).toISOString();

      await transitionOrderRpc(owner)('transition_order', {
        p_actor: fixture.userId,
        p_call_state: 'validated',
        p_cash_state: 'expected',
        p_delivery_state: 'scheduled',
        p_order_id: orderId,
        p_scheduled_for: scheduledFor,
      });
      const firstDelivery = await transitionOrderRpc(owner)('transition_order', {
        p_actor: fixture.userId,
        p_call_state: 'validated',
        p_cash_state: 'collected',
        p_delivery_state: 'delivered',
        p_order_id: orderId,
        p_order_state: 'completed',
        p_payment_channel: 'ESPECES',
      });
      expect(firstDelivery.error).toBeNull();

      const { data: firstStored } = await fixture.admin
        .from('orders')
        .select('cash_collected_at')
        .eq('id', orderId)
        .single();
      const firstCashCollectedAt = firstStored?.cash_collected_at;
      expect(firstCashCollectedAt).not.toBeNull();

      // Second appel identique (rejoue "livrer") : la garde `cash_collected_at is null`
      // doit rester intacte malgré le changement de branche.
      const secondDelivery = await transitionOrderRpc(owner)('transition_order', {
        p_actor: fixture.userId,
        p_call_state: 'validated',
        p_cash_state: 'collected',
        p_delivery_state: 'delivered',
        p_order_id: orderId,
        p_order_state: 'completed',
        p_payment_channel: 'ESPECES',
      });
      expect(secondDelivery.error).toBeNull();

      const { data: secondStored } = await fixture.admin
        .from('orders')
        .select('cash_collected_at')
        .eq('id', orderId)
        .single();
      expect(secondStored?.cash_collected_at).toBe(firstCashCollectedAt);
    },
  );

  it.skipIf(!supabaseUrl || !serviceRoleKey || !anonKey)(
    'programmée puis déprogrammée puis reconfirmée sans reprogrammer : fallback now(), aucune valeur fantôme',
    async () => {
      const fixture = await createOwnerFixture('cca-deprogrammed');
      const orderId = await createOrder(fixture.admin, fixture.merchantAccountId, 'CONFIRMEE');
      const owner = await signIn(fixture.email);
      const oldScheduledFor = new Date(Date.now() - 10 * 86_400_000).toISOString();

      const programmed = await transitionOrderRpc(owner)('transition_order', {
        p_actor: fixture.userId,
        p_call_state: 'validated',
        p_cash_state: 'expected',
        p_delivery_state: 'scheduled',
        p_order_id: orderId,
        p_scheduled_for: oldScheduledFor,
      });
      expect(programmed.error).toBeNull();

      // deconfirmer (Lot B) : efface scheduled_for explicitement.
      const deconfirmed = await transitionOrderRpc(owner)('transition_order', {
        p_actor: fixture.userId,
        p_call_state: 'to_call',
        p_cash_state: 'not_due',
        p_clear_scheduled_for: true,
        p_delivery_state: 'unassigned',
        p_order_id: orderId,
      });
      expect(deconfirmed.error).toBeNull();

      const { data: afterDeconfirm } = await fixture.admin
        .from('orders')
        .select('scheduled_for')
        .eq('id', orderId)
        .single();
      expect(afterDeconfirm?.scheduled_for).toBeNull();

      // confirmer : ne pose jamais scheduledFor (lib/domain/order-transition-actions.ts).
      const reconfirmed = await transitionOrderRpc(owner)('transition_order', {
        p_actor: fixture.userId,
        p_call_state: 'validated',
        p_order_id: orderId,
      });
      expect(reconfirmed.error).toBeNull();

      const before = Date.now();
      const delivered = await transitionOrderRpc(owner)('transition_order', {
        p_actor: fixture.userId,
        p_call_state: 'validated',
        p_cash_state: 'collected',
        p_delivery_state: 'delivered',
        p_order_id: orderId,
        p_order_state: 'completed',
        p_payment_channel: 'ESPECES',
      });
      const after = Date.now();
      expect(delivered.error).toBeNull();
      expect(delivered.data).toBe('LIVREE');

      const { data: stored } = await fixture.admin
        .from('orders')
        .select('cash_collected_at')
        .eq('id', orderId)
        .single();
      expect(stored?.cash_collected_at).not.toBeNull();
      const collectedAtMs = new Date(stored?.cash_collected_at as string).getTime();
      // Ni valeur fantôme de l'ancien scheduled_for, ni égalité exacte à now() : fenêtre.
      expect(collectedAtMs).not.toBe(new Date(oldScheduledFor).getTime());
      expect(collectedAtMs).toBeGreaterThanOrEqual(before);
      expect(collectedAtMs).toBeLessThanOrEqual(after);
    },
  );
});

describe('orders_source_check — source "appel" (migration 0097)', () => {
  it.skipIf(!supabaseUrl || !serviceRoleKey)(
    'accepte "appel" et rejette toujours une valeur hors liste',
    async () => {
      const fixture = await createOwnerFixture('source-appel');
      const orderId = await createOrder(fixture.admin, fixture.merchantAccountId, 'A_APPELER');

      const { error: acceptedError } = await fixture.admin
        .from('orders')
        .update({ source: 'appel' })
        .eq('id', orderId);
      expect(acceptedError).toBeNull();

      const { error: rejectedError } = await fixture.admin
        .from('orders')
        .update({ source: 'not-a-real-source' })
        .eq('id', orderId);
      expect(rejectedError?.message).toContain('orders_source_check');
    },
  );
});
