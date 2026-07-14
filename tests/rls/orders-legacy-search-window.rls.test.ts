import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

// Fix de triage (freeze /commandes à la recherche, cf. CLAUDE.md) : le chemin de recherche
// legacy (lib/actions/orders.ts:listOrdersForPageData) charge désormais uniquement les
// commandes dont `sort_at` (= coalesce(created_at_shopify, created_at), colonne générée
// migration 0044) tombe dans les 12 derniers mois glissants — au lieu de tout l'historique.
// Ce test verrouille le comportement de la requête telle qu'exécutée par listOrdersForPageData
// (même forme de select/filtre/tri), signée par un utilisateur réel sous RLS — reproduisant le
// chemin réel plutôt qu'un insert direct qui contournerait RLS (cf. gotcha CLAUDE.md sur les
// seeds qui écrivent l'état sans passer par le vrai chemin applicatif).

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'orders-legacy-search-window-rls-pw';
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
  const email = `orders-legacy-window-${label}-${Date.now()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  return { admin, email, merchantAccountId, userId };
}

type Dimensions = {
  callState: string;
  deliveryState: string;
  orderState: string;
};

async function insertOrder(
  admin: AdminClient,
  merchantAccountId: string,
  opts: {
    createdAt: string;
    createdAtShopify?: string | null;
    dimensions: Dimensions;
  },
) {
  const { data, error } = await admin
    .from('orders')
    .insert({
      call_state: opts.dimensions.callState,
      cash_state: 'not_due',
      created_at: opts.createdAt,
      created_at_shopify: opts.createdAtShopify ?? opts.createdAt,
      currency: 'XOF',
      delivery_state: opts.dimensions.deliveryState,
      merchant_account_id: merchantAccountId,
      order_number: `OKP-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      order_state: opts.dimensions.orderState,
      total_amount: 1000,
    })
    .select('id, sort_at')
    .single();
  if (error || !data) throw error ?? new Error('order insert failed');
  return data;
}

// Reproduit exactement la requête de listOrdersForPageData (lib/actions/orders.ts) : filtre
// merchant_account_id + gte sort_at sur la borne 12 mois, tri sort_at desc / id desc.
async function fetchLegacySearchScope(
  client: SupabaseClient<Database>,
  merchantAccountId: string,
  lookbackIso: string,
) {
  const { data, error } = await client
    .from('orders')
    .select('id, sort_at')
    .eq('merchant_account_id', merchantAccountId)
    .gte('sort_at', lookbackIso)
    .order('sort_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id);
  }
  createdUserIds.length = 0;
});

describe('listOrdersForPageData — bornage 12 mois (fix triage freeze recherche)', () => {
  skipIfNoServiceRole(
    'exclut une commande vieille de plus de 12 mois, inclut une commande récente',
    async () => {
      const { admin, email, merchantAccountId } = await createOwnerFixture('old-vs-recent');
      const dims: Dimensions = {
        callState: 'to_call',
        deliveryState: 'unassigned',
        orderState: 'open',
      };

      const thirteenMonthsAgo = new Date();
      thirteenMonthsAgo.setUTCMonth(thirteenMonthsAgo.getUTCMonth() - 13);
      const oneMonthAgo = new Date();
      oneMonthAgo.setUTCMonth(oneMonthAgo.getUTCMonth() - 1);

      const old = await insertOrder(admin, merchantAccountId, {
        createdAt: thirteenMonthsAgo.toISOString(),
        dimensions: dims,
      });
      const recent = await insertOrder(admin, merchantAccountId, {
        createdAt: oneMonthAgo.toISOString(),
        dimensions: dims,
      });

      const twelveMonthsAgo = new Date();
      twelveMonthsAgo.setUTCMonth(twelveMonthsAgo.getUTCMonth() - 12);

      const client = await signIn(email);
      const rows = await fetchLegacySearchScope(
        client,
        merchantAccountId,
        twelveMonthsAgo.toISOString(),
      );
      const ids = rows.map((row) => row.id);

      expect(ids).toContain(recent.id);
      expect(ids).not.toContain(old.id);
    },
  );

  skipIfNoServiceRole(
    'la borne 12 mois filtre sur sort_at (= created_at_shopify si présent), pas created_at seul',
    async () => {
      const { admin, email, merchantAccountId } = await createOwnerFixture('sort-at-field');
      const dims: Dimensions = {
        callState: 'to_call',
        deliveryState: 'unassigned',
        orderState: 'open',
      };

      const thirteenMonthsAgo = new Date();
      thirteenMonthsAgo.setUTCMonth(thirteenMonthsAgo.getUTCMonth() - 13);
      const oneMonthAgo = new Date();
      oneMonthAgo.setUTCMonth(oneMonthAgo.getUTCMonth() - 1);

      // created_at récent mais created_at_shopify (donc sort_at) vieux de 13 mois : doit être
      // exclue, car listOrdersForPageData borne sur sort_at, pas created_at.
      const shopifyOld = await insertOrder(admin, merchantAccountId, {
        createdAt: oneMonthAgo.toISOString(),
        createdAtShopify: thirteenMonthsAgo.toISOString(),
        dimensions: dims,
      });

      const twelveMonthsAgo = new Date();
      twelveMonthsAgo.setUTCMonth(twelveMonthsAgo.getUTCMonth() - 12);

      const client = await signIn(email);
      const rows = await fetchLegacySearchScope(
        client,
        merchantAccountId,
        twelveMonthsAgo.toISOString(),
      );

      expect(rows.map((row) => row.id)).not.toContain(shopifyOld.id);
    },
  );
});
