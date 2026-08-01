import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

// 0119 — finance_kpis se rebase sur cash_collected_at pour dater les livraisons.
//
// AVANT : finance_kpis.ca_livre/delivered_orders_count dataient une commande livrée par
// order_state_transition.created_at (le clic serveur), jamais par cash_collected_at (la date
// de livraison réelle, éditable depuis 0114). Une commande livrée réellement en juillet mais
// cliquée en août tombait en AOÛT dans finance_kpis, alors que le P&L (report-data.ts,
// déjà sur cash_collected_at) la comptait en JUILLET — même écran /finances, deux mois
// différents pour la même commande.
//
// APRÈS : delivered_at = coalesce(cash_collected_at, ancien fallback). Les tests ci-dessous
// prouvent (1) la non-régression via une VRAIE transition RPC (jamais un insert direct) avec
// cash_collected_at édité franchissant une frontière de mois, et (2) le fallback pour les
// commandes sans cash_collected_at (aucune donnée réelle de ce type sur le pilote — fixture
// nécessaire, cf. audit Phase A-bis).

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'finance-kpis-cca-rls-pw';
const createdUserIds: string[] = [];

const skipIfNoServiceRole = !serviceRoleKey ? it.skip : it;

type AdminClient = SupabaseClient<Database>;

type TransitionArgs = {
  p_actor: string;
  p_order_id: string;
  p_call_confirmed_at?: string;
  p_call_state?: string;
  p_cash_state?: string;
  p_delivery_state?: string;
  p_order_state?: string;
  p_payment_channel?: string;
  p_scheduled_for?: string;
  p_delivered_at?: string;
};

function adminClient(): AdminClient {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function transitionRpc(client: SupabaseClient<Database>) {
  return client.rpc.bind(client) as unknown as (
    fn: 'transition_order',
    args: TransitionArgs,
  ) => Promise<{ data: string | null; error: { message: string } | null }>;
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
  const email = `finance-kpis-cca-${label}-${Date.now()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  return { admin, email, merchantAccountId, userId };
}

async function createOrder(admin: AdminClient, merchantAccountId: string, totalAmount: number) {
  const { data, error } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      order_number: `FKCCA-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
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

// Backdate large (90j) : deliveredAt (1er du mois précédent, cf. scénario) tombe toujours dans
// les ~62 jours qui précèdent "maintenant" au pire des cas (aujourd'hui = fin de mois) — la
// borne basse serveur (least(created_at, created_at_shopify)) doit rester strictement avant.
async function backdateOrder(admin: AdminClient, orderId: string, daysAgo: number) {
  const createdAt = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  const { error } = await admin
    .from('orders')
    .update({ created_at: createdAt, created_at_shopify: createdAt })
    .eq('id', orderId);
  expect(error).toBeNull();
}

async function financeKpis(
  client: SupabaseClient<Database>,
  merchantId: string,
  from: Date,
  to: Date,
) {
  const { data, error } = await client.rpc('finance_kpis', {
    p_merchant: merchantId,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  if (error) throw error;
  return data[0];
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id);
  }
  createdUserIds.length = 0;
});

describe('0119 — finance_kpis date les livraisons sur cash_collected_at', () => {
  skipIfNoServiceRole(
    'commande livrée réellement le mois dernier mais cliquée ce mois-ci : comptée dans le mois de cash_collected_at, PAS dans celui du clic — et alignée avec le filtre P&L',
    async () => {
      const { admin, email, merchantAccountId, userId } = await createOwnerFixture('crossmonth');
      const orderId = await createOrder(admin, merchantAccountId, 20000);
      await backdateOrder(admin, orderId, 90);
      const client = await signIn(email);

      const now = new Date();
      // 1er jour du mois précédent, à midi UTC — toujours dans le mois précédent quel que
      // soit le jour du mois où le test tourne (contrairement à "il y a N jours").
      const prevMonthStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 12, 0, 0),
      );
      const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

      // La confirmation doit précéder la livraison (garde 0114 invalid_confirmation_after_delivery) :
      // le client a confirmé la veille de la livraison réelle, pas "maintenant".
      const confirmedAt = new Date(prevMonthStart.getTime() - 86_400_000);

      await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_call_confirmed_at: confirmedAt.toISOString(),
        p_call_state: 'validated',
        p_cash_state: 'expected',
        p_delivery_state: 'scheduled',
      });

      // Le clic « Marquer livrée » se produit MAINTENANT (mois courant), mais la date de
      // livraison réelle saisie dans le popup est le mois précédent.
      const delivered = await transitionRpc(client)('transition_order', {
        p_actor: userId,
        p_order_id: orderId,
        p_cash_state: 'collected',
        p_delivered_at: prevMonthStart.toISOString(),
        p_delivery_state: 'delivered',
        p_order_state: 'completed',
        p_payment_channel: 'ESPECES',
      });
      expect(delivered.error).toBeNull();
      expect(delivered.data).toBe('LIVREE');

      const { data: stored } = await admin
        .from('orders')
        .select('cash_collected_at')
        .eq('id', orderId)
        .single();
      expect(new Date(stored?.cash_collected_at as string).getTime()).toBe(
        prevMonthStart.getTime(),
      );

      // finance_kpis sur le MOIS PRÉCÉDENT (fenêtre = cash_collected_at) : la commande y est.
      const prevMonthKpis = await financeKpis(
        client,
        merchantAccountId,
        prevMonthStart,
        currentMonthStart,
      );
      expect(Number(prevMonthKpis.delivered_orders_count)).toBe(1);
      expect(Number(prevMonthKpis.ca_livre)).toBe(20000);

      // finance_kpis sur le MOIS COURANT (fenêtre = clic) : la commande n'y est PLUS — avant
      // 0119, order_state_transition.created_at (le clic, "now") l'aurait fait apparaître ici.
      const currentMonthKpis = await financeKpis(
        client,
        merchantAccountId,
        currentMonthStart,
        nextMonthStart,
      );
      expect(Number(currentMonthKpis.delivered_orders_count)).toBe(0);
      expect(Number(currentMonthKpis.ca_livre)).toBe(0);

      // Alignement avec le P&L (lib/finance/report-data.ts:57-58, filtre .gte/.lte sur
      // cash_collected_at, inchangé par ce lot) : la même requête, directement, confirme que
      // le P&L verrait aussi cette commande dans le mois précédent — même mois que
      // finance_kpis, ce qui est précisément l'incohérence que ce lot corrige.
      const { data: plWindowRows, error: plWindowError } = await admin
        .from('orders')
        .select('id')
        .eq('merchant_account_id', merchantAccountId)
        .gte('cash_collected_at', prevMonthStart.toISOString())
        .lte('cash_collected_at', new Date(currentMonthStart.getTime() - 1).toISOString());
      expect(plWindowError).toBeNull();
      expect(plWindowRows?.map((row) => row.id)).toContain(orderId);
    },
  );

  skipIfNoServiceRole(
    'commande livrée avant 0096 (cash_collected_at NULL) : fallback sur order_state_transition.created_at, ne disparaît pas et ne change pas de mois',
    async () => {
      // Aucune donnée réelle du pilote n'a cash_collected_at NULL (confirmé Phase A-bis) : ce
      // scénario n'est atteignable qu'en insert direct (comme lib/report/data.ts:402
      // documente déjà pour un cas voisin), il simule une commande livrée avant l'existence du
      // champ (avant 0096) — le seul moyen de fabriquer cet état, la RPC transition_order pose
      // toujours cash_collected_at aujourd'hui.
      const { admin, email, merchantAccountId, userId } =
        await createOwnerFixture('fallback-null-cca');
      const orderId = await createOrder(admin, merchantAccountId, 15000);

      const deliveredAt = new Date(Date.now() - 20 * 86_400_000);
      const { error: updateError } = await admin
        .from('orders')
        .update({
          cod_status: 'LIVREE',
          order_state: 'completed',
          call_state: 'validated',
          delivery_state: 'delivered',
          cash_state: 'collected',
          cash_collected_at: null,
          updated_at: deliveredAt.toISOString(),
        })
        .eq('id', orderId);
      expect(updateError).toBeNull();

      const { error: transitionInsertError } = await admin.from('order_state_transition').insert({
        merchant_account_id: merchantAccountId,
        order_id: orderId,
        from_status: 'EN_LIVRAISON',
        to_status: 'LIVREE',
        actor_user_id: userId,
        created_at: deliveredAt.toISOString(),
      });
      expect(transitionInsertError).toBeNull();

      // finance_kpis est security definer avec une garde de rôle basée sur auth.uid() —
      // un appel service-role (sans session) échouerait silencieusement la garde (rôle NULL).
      // On appelle donc via la session réelle du owner, comme le reste des tests de ce fichier.
      const client = await signIn(email);
      const kpis = await financeKpis(
        client,
        merchantAccountId,
        new Date(deliveredAt.getTime() - 86_400_000),
        new Date(deliveredAt.getTime() + 86_400_000),
      );

      // Fallback identique au comportement d'avant ce lot : delivered_at retombe sur
      // order_state_transition.created_at (aucune régression pour cette commande historique).
      expect(Number(kpis.delivered_orders_count)).toBe(1);
      expect(Number(kpis.ca_livre)).toBe(15000);
    },
  );
});
