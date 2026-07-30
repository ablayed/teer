import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

// 0117 — `finance_kpis.delivered_orders_count` ferme le gap « Invalider » (0116) sur /finances.
//
// AVANT : la page comptait ses livraisons avec une requête AUTONOME sur
// order_state_transition (to_status='LIVREE', fenêtrée sur created_at), sans jointure vers
// `orders`. Deux défauts, prouvés ci-dessous par les mêmes scénarios :
//   1. une commande INVALIDÉE restait comptée (sa transition LIVREE subsiste volontairement) ;
//   2. une commande livrée → invalidée → RE-livrée comptait DEUX fois (comptage de LIGNES de
//      transition, pas de commandes distinctes) — cas rendu possible précisément par 0116.
// Enjeu non cosmétique : ce compteur alimente lib/finance/fees.ts:106
// (deliveryCostsMinor = delivered * default_delivery_cost_minor), une ligne de COÛT du P&L.
//
// APRÈS : le comptage vient de la CTE `delivered_orders` de finance_kpis, déjà bornée à
// `o.cod_status = 'LIVREE'` (état COURANT) et groupée par o.id.

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'finance-delivered-count-rls-pw';
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
  const email = `finance-delivered-count-${label}-${Date.now()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  return { admin, email, merchantAccountId, userId };
}

async function createDriver(admin: AdminClient, merchantAccountId: string) {
  const { data, error } = await admin
    .from('driver')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: 'Livreur FDC 0117',
      phone: `+2217${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('driver insert failed');
  return data.id;
}

async function createOrder(admin: AdminClient, merchantAccountId: string, totalAmount: number) {
  const { data, error } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      order_number: `FDC117-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      total_amount: totalAmount,
      currency: 'XOF',
      order_state: 'open',
      call_state: 'to_call',
      delivery_state: 'unassigned',
      cash_state: 'not_due',
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('order insert failed');
  return data.id;
}

// Signature declaree a la main, comme dans les autres specs RLS de transition_order
// (orders-dimensions, product-bundle-cascade) : le type genere expose bien les 20 arguments
// depuis le push de 0116, mais l'inference PostgREST sur une RPC a autant d'arguments
// optionnels reste illisible en cas d'erreur. On garde la convention du projet.
type TransitionArgs = {
  p_actor: string;
  p_order_id: string;
  p_assigned_driver_id?: string;
  p_call_state?: string;
  p_cash_state?: string;
  p_delivery_state?: string;
  p_order_state?: string;
  p_payment_channel?: string;
  p_clear_assigned_driver?: boolean;
  p_clear_cancel_reasons?: boolean;
  p_clear_scheduled_for?: boolean;
  p_invalidate_delivered?: boolean;
};

function transitionRpc(client: SupabaseClient<Database>) {
  return client.rpc.bind(client) as unknown as (
    fn: 'transition_order',
    args: TransitionArgs,
  ) => Promise<{ data: string | null; error: { message: string } | null }>;
}

// Parcours réel jusqu'à LIVREE — jamais un insert direct : il faut de VRAIES lignes
// order_state_transition, sinon le défaut qu'on corrige (compter ces lignes) serait
// invisible et le test vert pour une mauvaise raison.
async function driveToDelivered(
  client: SupabaseClient<Database>,
  userId: string,
  orderId: string,
  driverId: string,
) {
  await transitionRpc(client)('transition_order', {
    p_actor: userId,
    p_order_id: orderId,
    p_call_state: 'validated',
    p_cash_state: 'expected',
    p_delivery_state: 'scheduled',
  });
  await transitionRpc(client)('transition_order', {
    p_actor: userId,
    p_order_id: orderId,
    p_delivery_state: 'assigned',
    p_assigned_driver_id: driverId,
  });
  const delivered = await transitionRpc(client)('transition_order', {
    p_actor: userId,
    p_order_id: orderId,
    p_delivery_state: 'delivered',
    p_order_state: 'completed',
    p_cash_state: 'collected',
    p_payment_channel: 'ESPECES',
  });
  expect(delivered.error).toBeNull();
  expect(delivered.data).toBe('LIVREE');
}

async function invalidate(client: SupabaseClient<Database>, userId: string, orderId: string) {
  const result = await transitionRpc(client)('transition_order', {
    p_actor: userId,
    p_order_id: orderId,
    p_order_state: 'open',
    p_call_state: 'to_call',
    p_delivery_state: 'unassigned',
    p_cash_state: 'not_due',
    p_clear_assigned_driver: true,
    p_clear_cancel_reasons: true,
    p_clear_scheduled_for: true,
    p_invalidate_delivered: true,
  });
  expect(result.error).toBeNull();
  expect(result.data).toBe('A_APPELER');
}

async function financeKpis(client: SupabaseClient<Database>, merchantId: string) {
  const { data, error } = await client.rpc('finance_kpis', {
    p_merchant: merchantId,
    p_from: new Date(Date.now() - 365 * 86_400_000).toISOString(),
    p_to: new Date(Date.now() + 86_400_000).toISOString(),
  });
  if (error) throw error;
  // 0117 applique en prod : `delivered_orders_count` vient desormais du type genere,
  // plus aucun cast n'est necessaire ici.
  return data[0];
}

// Le comptage que faisait la page AVANT 0117, reproduit tel quel pour prouver que le
// scénario expose bien le défaut (sinon le test ne démontrerait rien).
async function legacyTransitionRowCount(
  admin: AdminClient,
  merchantAccountId: string,
): Promise<number> {
  const { count, error } = await admin
    .from('order_state_transition')
    .select('id', { count: 'exact', head: true })
    .eq('merchant_account_id', merchantAccountId)
    .eq('to_status', 'LIVREE');
  if (error) throw error;
  return count ?? 0;
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id);
  }
  createdUserIds.length = 0;
});

describe('0117 — finance_kpis.delivered_orders_count suit l’état COURANT de la commande', () => {
  skipIfNoServiceRole('une commande livree compte 1 et son CA est pris en compte', async () => {
    const { admin, email, merchantAccountId, userId } = await createOwnerFixture('base');
    const driverId = await createDriver(admin, merchantAccountId);
    const orderId = await createOrder(admin, merchantAccountId, 20000);

    const client = await signIn(email);
    await driveToDelivered(client, userId, orderId, driverId);

    const kpis = await financeKpis(client, merchantAccountId);
    expect(Number(kpis.delivered_orders_count)).toBe(1);
    expect(Number(kpis.ca_livre)).toBe(20000);
  });

  skipIfNoServiceRole(
    'une commande INVALIDEE disparait du comptage ET du CA livre, alors que sa transition subsiste',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('invalidee');
      const driverId = await createDriver(admin, merchantAccountId);
      const orderId = await createOrder(admin, merchantAccountId, 20000);

      const client = await signIn(email);
      await driveToDelivered(client, userId, orderId, driverId);
      expect(Number((await financeKpis(client, merchantAccountId)).delivered_orders_count)).toBe(1);

      await invalidate(client, userId, orderId);

      const kpis = await financeKpis(client, merchantAccountId);
      // Le fait central : plus comptee, et son CA sort aussi de la fenetre.
      expect(Number(kpis.delivered_orders_count)).toBe(0);
      expect(Number(kpis.ca_livre)).toBe(0);

      // L'historique n'a PAS ete reecrit (regle du lot) : la transition LIVREE est toujours
      // la. C'est ce qui prouve que le correctif vient de la lecture de l'etat courant, et
      // pas d'une suppression de donnee.
      expect(await legacyTransitionRowCount(admin, merchantAccountId)).toBe(1);
      const { data: order } = await admin
        .from('orders')
        .select('cod_status, cash_collected_at')
        .eq('id', orderId)
        .single();
      expect(order?.cod_status).toBe('A_APPELER');
      expect(order?.cash_collected_at).toBeNull();
    },
  );

  skipIfNoServiceRole(
    'livree -> invalidee -> RE-livree compte 1, pas 2 (l’ancien comptage de lignes en voyait 2)',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('relivree');
      const driverId = await createDriver(admin, merchantAccountId);
      const orderId = await createOrder(admin, merchantAccountId, 20000);

      const client = await signIn(email);
      await driveToDelivered(client, userId, orderId, driverId);
      await invalidate(client, userId, orderId);
      await driveToDelivered(client, userId, orderId, driverId);

      // Le defaut est bien present dans les donnees : 2 lignes de transition LIVREE.
      expect(await legacyTransitionRowCount(admin, merchantAccountId)).toBe(2);

      // Mais une seule COMMANDE est livree, et le CA n'est compte qu'une fois.
      const kpis = await financeKpis(client, merchantAccountId);
      expect(Number(kpis.delivered_orders_count)).toBe(1);
      expect(Number(kpis.ca_livre)).toBe(20000);
    },
  );

  skipIfNoServiceRole('agent : garde de role inchangee, aucune ligne renvoyee', async () => {
    const { admin, email, merchantAccountId, userId } = await createOwnerFixture('rbac');
    const driverId = await createDriver(admin, merchantAccountId);
    const orderId = await createOrder(admin, merchantAccountId, 20000);
    const owner = await signIn(email);
    await driveToDelivered(owner, userId, orderId, driverId);

    const agentEmail = `finance-delivered-count-agent-${Date.now()}@example.com`;
    const agentUserId = await createConfirmedUser(admin, agentEmail);
    await admin.from('merchant_member').delete().eq('user_id', agentUserId);
    await admin.from('merchant_member').insert({
      merchant_account_id: merchantAccountId,
      user_id: agentUserId,
      role: 'agent',
    });
    const agentClient = await signIn(agentEmail);

    const { data, error } = await agentClient.rpc('finance_kpis', {
      p_merchant: merchantAccountId,
      p_from: new Date(Date.now() - 365 * 86_400_000).toISOString(),
      p_to: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});
