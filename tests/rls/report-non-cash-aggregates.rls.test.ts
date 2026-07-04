import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

// Lot 4 (migration 0085) — get_report_status_breakdown / get_report_revenue_by_day /
// get_report_top_products remplacent l'agrégation JS de getReportData (rapport PDF) sur
// `scopedOrdersQuery`, un select `orders` fenêtré SANS `.range()` (cap PostgREST max_rows=1000
// silencieux sur les gros tenants/grosses fenêtres). Les 3 RPC doivent reproduire EXACTEMENT
// les formules actuelles (statuses[]/margin_estimee, revenue[] bucket UTC, topProducts[]
// price_minor>price, pas de filtre cod_status, titre vide -> 'Produit'), pas les contrats
// voisins get_dashboard_*/0080 qui diffèrent (filtre statut, règle prix, top 5 vs 10).

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'report-non-cash-rls-pw';
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
  const email = `report-non-cash-${label}-${Date.now()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  return { admin, email, merchantAccountId, userId };
}

async function addMember(admin: AdminClient, merchantAccountId: string, role: 'agent' | 'manager') {
  const email = `report-non-cash-member-${role}-${Date.now()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  // L'utilisateur créé ci-dessus obtient AUSSI son propre merchant_account (trigger de
  // signup) — on le retire pour ne garder que le membership sur le tenant du test.
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
      shop_domain: `rpt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.myshopify.com`,
      access_token_encrypted: 'test-token',
      scopes: 'read_orders',
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('shop insert failed');
  return data.id;
}

// cod_status est trigger-dérivé (derive_legacy_cod_status, 0023) : on écrit les 4 dimensions,
// jamais cod_status directement (CLAUDE.md). Combos utilisés : LIVREE (delivery_state=delivered)
// et A_APPELER (else — aucune des règles de dérivation ne matche).
const LIVREE_DIMENSIONS = {
  callState: 'validated',
  cashState: 'collected',
  deliveryState: 'delivered',
  orderState: 'open',
} as const;
const A_APPELER_DIMENSIONS = {
  callState: 'to_call',
  cashState: 'not_due',
  deliveryState: 'unassigned',
  orderState: 'open',
} as const;

async function insertOrder(
  admin: AdminClient,
  merchantAccountId: string,
  opts: {
    dimensions: {
      callState: string;
      cashState: string;
      deliveryState: string;
      orderState: string;
    };
    createdAt?: string;
    itemsSummary?: unknown;
    shopId?: string | null;
    totalAmount: number;
    updatedAt?: string;
  },
) {
  const createdAt = opts.createdAt ?? new Date().toISOString();
  const { data, error } = await admin
    .from('orders')
    .insert({
      call_state: opts.dimensions.callState,
      cash_state: opts.dimensions.cashState,
      created_at: createdAt,
      created_at_shopify: createdAt,
      currency: 'XOF',
      delivery_state: opts.dimensions.deliveryState,
      items_summary: (opts.itemsSummary ?? null) as never,
      merchant_account_id: merchantAccountId,
      order_number: `RPT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      order_state: opts.dimensions.orderState,
      shop_id: opts.shopId ?? null,
      total_amount: opts.totalAmount,
      updated_at: opts.updatedAt ?? createdAt,
    })
    .select('cod_status, id')
    .single();
  if (error || !data) throw error ?? new Error('order insert failed');
  return data;
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id);
  }
  createdUserIds.length = 0;
});

describe('get_report_status_breakdown (Lot 4, 0085)', () => {
  skipIfNoServiceRole('group by cod_status : count et amount_minor exacts par statut', async () => {
    const { admin, email, merchantAccountId } = await createOwnerFixture('status-breakdown');
    const from = new Date(Date.now() - 10 * 86_400_000);
    const to = new Date(Date.now() + 86_400_000);

    await insertOrder(admin, merchantAccountId, {
      dimensions: A_APPELER_DIMENSIONS,
      totalAmount: 1000,
    });
    await insertOrder(admin, merchantAccountId, {
      dimensions: A_APPELER_DIMENSIONS,
      totalAmount: 2000,
    });
    await insertOrder(admin, merchantAccountId, {
      dimensions: LIVREE_DIMENSIONS,
      totalAmount: 5000,
    });

    const client = await signIn(email);
    const { data, error } = await client.rpc('get_report_status_breakdown', {
      p_from: from.toISOString(),
      p_merchant_id: merchantAccountId,
      p_to: to.toISOString(),
    });
    if (error) throw error;

    const aAppeler = (data ?? []).find((row) => row.cod_status === 'A_APPELER');
    const livree = (data ?? []).find((row) => row.cod_status === 'LIVREE');

    expect(aAppeler?.count).toBe(2);
    expect(aAppeler?.amount_minor).toBe(3000);
    expect(livree?.count).toBe(1);
    expect(livree?.amount_minor).toBe(5000);
  });

  skipIfNoServiceRole(
    'bornes de fenêtre INCLUSIVES aux deux extrémités, commande hors fenêtre exclue',
    async () => {
      const { admin, email, merchantAccountId } =
        await createOwnerFixture('status-breakdown-window');
      const from = new Date(Date.now() - 10 * 86_400_000);
      const to = new Date(Date.now() - 5 * 86_400_000);

      await insertOrder(admin, merchantAccountId, {
        createdAt: from.toISOString(),
        dimensions: A_APPELER_DIMENSIONS,
        totalAmount: 1000,
      });
      await insertOrder(admin, merchantAccountId, {
        createdAt: to.toISOString(),
        dimensions: A_APPELER_DIMENSIONS,
        totalAmount: 2000,
      });
      await insertOrder(admin, merchantAccountId, {
        createdAt: new Date(Date.now() - 1 * 86_400_000).toISOString(), // après `to`
        dimensions: A_APPELER_DIMENSIONS,
        totalAmount: 9000,
      });

      const client = await signIn(email);
      const { data, error } = await client.rpc('get_report_status_breakdown', {
        p_from: from.toISOString(),
        p_merchant_id: merchantAccountId,
        p_to: to.toISOString(),
      });
      if (error) throw error;

      const aAppeler = (data ?? []).find((row) => row.cod_status === 'A_APPELER');
      expect(aAppeler?.count).toBe(2);
      expect(aAppeler?.amount_minor).toBe(3000);
    },
  );

  skipIfNoServiceRole('agent : accès refusé (garde de rôle, ni owner ni manager)', async () => {
    const { admin, merchantAccountId } = await createOwnerFixture('status-breakdown-agent');
    await insertOrder(admin, merchantAccountId, {
      dimensions: A_APPELER_DIMENSIONS,
      totalAmount: 1000,
    });
    const { email: agentEmail } = await addMember(admin, merchantAccountId, 'agent');
    const client = await signIn(agentEmail);

    const result = await client.rpc('get_report_status_breakdown', {
      p_from: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      p_merchant_id: merchantAccountId,
      p_to: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(result.error).not.toBeNull();
  });

  skipIfNoServiceRole(
    'isolation tenant : owner du tenant B ne peut pas lire les statuts du tenant A (rôle NULL)',
    async () => {
      const { admin, merchantAccountId: merchantA } =
        await createOwnerFixture('status-breakdown-a');
      await insertOrder(admin, merchantA, {
        dimensions: A_APPELER_DIMENSIONS,
        totalAmount: 1000,
      });
      const { email: emailB } = await createOwnerFixture('status-breakdown-b');
      const clientB = await signIn(emailB);

      const result = await clientB.rpc('get_report_status_breakdown', {
        p_from: new Date(Date.now() - 30 * 86_400_000).toISOString(),
        p_merchant_id: merchantA,
        p_to: new Date(Date.now() + 86_400_000).toISOString(),
      });
      expect(result.error).not.toBeNull();
    },
  );
});

describe('get_report_revenue_by_day (Lot 4, 0085)', () => {
  skipIfNoServiceRole(
    'bucket jour calendaire UTC de coalesce(updated_at,created_at), LIVREE uniquement',
    async () => {
      const { admin, email, merchantAccountId } = await createOwnerFixture('revenue-bucket');
      // 23h59 UTC un jour J → doit tomber dans le bucket J, pas J+1 (piège TZ classique).
      const deliveredAt = new Date('2026-03-10T23:59:00.000Z');
      const createdAt = new Date('2026-03-10T08:00:00.000Z');

      await insertOrder(admin, merchantAccountId, {
        createdAt: createdAt.toISOString(),
        dimensions: LIVREE_DIMENSIONS,
        totalAmount: 7500,
        updatedAt: deliveredAt.toISOString(),
      });
      // Non-LIVREE dans la même fenêtre : ne doit contribuer à aucun bucket.
      await insertOrder(admin, merchantAccountId, {
        createdAt: createdAt.toISOString(),
        dimensions: A_APPELER_DIMENSIONS,
        totalAmount: 4000,
      });

      const client = await signIn(email);
      const { data, error } = await client.rpc('get_report_revenue_by_day', {
        p_from: new Date('2026-03-01T00:00:00.000Z').toISOString(),
        p_merchant_id: merchantAccountId,
        p_to: new Date('2026-03-20T00:00:00.000Z').toISOString(),
      });
      if (error) throw error;

      const bucket = (data ?? []).find((row) => row.day === '2026-03-10');
      expect(bucket?.amount_minor).toBe(7500);
      expect((data ?? []).reduce((total, row) => total + row.amount_minor, 0)).toBe(7500);
    },
  );

  skipIfNoServiceRole(
    'commande créée dans la fenêtre mais mise à jour après `to` : reste comptée, bucket hors fenêtre',
    async () => {
      const { admin, email, merchantAccountId } = await createOwnerFixture('revenue-late-update');
      const from = new Date('2026-04-01T00:00:00.000Z');
      const to = new Date('2026-04-10T00:00:00.000Z');
      const lateUpdate = new Date('2026-04-15T00:00:00.000Z'); // après `to`

      await insertOrder(admin, merchantAccountId, {
        createdAt: new Date('2026-04-05T00:00:00.000Z').toISOString(),
        dimensions: LIVREE_DIMENSIONS,
        totalAmount: 3000,
        updatedAt: lateUpdate.toISOString(),
      });

      const client = await signIn(email);
      const { data, error } = await client.rpc('get_report_revenue_by_day', {
        p_from: from.toISOString(),
        p_merchant_id: merchantAccountId,
        p_to: to.toISOString(),
      });
      if (error) throw error;

      // Filtre = created_at (dans la fenêtre), PAS la date de bucket : la commande reste
      // comptée, sur un jour hors [from,to] — comportement actuel reproduit à l'identique.
      const bucket = (data ?? []).find((row) => row.day === '2026-04-15');
      expect(bucket?.amount_minor).toBe(3000);
    },
  );

  skipIfNoServiceRole('agent : accès refusé (garde de rôle, ni owner ni manager)', async () => {
    const { admin, merchantAccountId } = await createOwnerFixture('revenue-agent');
    await insertOrder(admin, merchantAccountId, {
      dimensions: LIVREE_DIMENSIONS,
      totalAmount: 1000,
    });
    const { email: agentEmail } = await addMember(admin, merchantAccountId, 'agent');
    const client = await signIn(agentEmail);

    const result = await client.rpc('get_report_revenue_by_day', {
      p_from: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      p_merchant_id: merchantAccountId,
      p_to: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(result.error).not.toBeNull();
  });

  skipIfNoServiceRole(
    'isolation tenant : owner du tenant B ne peut pas lire le CA du tenant A (rôle NULL)',
    async () => {
      const { admin, merchantAccountId: merchantA } = await createOwnerFixture('revenue-a');
      await insertOrder(admin, merchantA, {
        dimensions: LIVREE_DIMENSIONS,
        totalAmount: 1000,
      });
      const { email: emailB } = await createOwnerFixture('revenue-b');
      const clientB = await signIn(emailB);

      const result = await clientB.rpc('get_report_revenue_by_day', {
        p_from: new Date(Date.now() - 30 * 86_400_000).toISOString(),
        p_merchant_id: merchantA,
        p_to: new Date(Date.now() + 86_400_000).toISOString(),
      });
      expect(result.error).not.toBeNull();
    },
  );
});

describe('get_report_top_products (Lot 4, 0085)', () => {
  skipIfNoServiceRole(
    'price_minor prioritaire sur price, titre vide groupé sous "Produit", aucun filtre de statut',
    async () => {
      const { admin, email, merchantAccountId } = await createOwnerFixture('top-products');
      const from = new Date(Date.now() - 10 * 86_400_000);
      const to = new Date(Date.now() + 86_400_000);

      // price_minor (1200) doit primer sur price (99) → 1200 * 2 = 2400.
      await insertOrder(admin, merchantAccountId, {
        dimensions: LIVREE_DIMENSIONS,
        itemsSummary: [{ price: 99, price_minor: 1200, quantity: 2, title: 'Robe Wax' }],
        totalAmount: 2400,
      });
      // Titre vide/absent → groupé sous 'Produit', et statut A_APPELER (pas de filtre statut).
      await insertOrder(admin, merchantAccountId, {
        dimensions: A_APPELER_DIMENSIONS,
        itemsSummary: [{ price: 500, quantity: 3, title: '   ' }],
        totalAmount: 1500,
      });
      // Même produit "Robe Wax" dans une 2e commande → doit s'agréger avec la 1ère.
      await insertOrder(admin, merchantAccountId, {
        dimensions: LIVREE_DIMENSIONS,
        itemsSummary: [{ price: 99, price_minor: 1200, quantity: 1, title: 'Robe Wax' }],
        totalAmount: 1200,
      });

      const client = await signIn(email);
      const { data, error } = await client.rpc('get_report_top_products', {
        p_from: from.toISOString(),
        p_merchant_id: merchantAccountId,
        p_to: to.toISOString(),
      });
      if (error) throw error;

      const robeWax = (data ?? []).find((row) => row.title === 'Robe Wax');
      const produit = (data ?? []).find((row) => row.title === 'Produit');

      expect(robeWax?.quantity).toBe(3); // 2 + 1
      expect(robeWax?.amount_minor).toBe(3600); // 1200*2 + 1200*1
      expect(produit?.quantity).toBe(3);
      expect(produit?.amount_minor).toBe(1500); // 500*3, statut A_APPELER inclus
    },
  );

  skipIfNoServiceRole(
    'scope boutique optionnel : exclut les commandes des autres boutiques',
    async () => {
      const { admin, email, merchantAccountId } = await createOwnerFixture('top-products-shop');
      const shopA = await createShop(admin, merchantAccountId);
      const shopB = await createShop(admin, merchantAccountId);

      await insertOrder(admin, merchantAccountId, {
        dimensions: LIVREE_DIMENSIONS,
        itemsSummary: [{ price: 1000, quantity: 1, title: 'Produit A' }],
        shopId: shopA,
        totalAmount: 1000,
      });
      await insertOrder(admin, merchantAccountId, {
        dimensions: LIVREE_DIMENSIONS,
        itemsSummary: [{ price: 2000, quantity: 1, title: 'Produit B' }],
        shopId: shopB,
        totalAmount: 2000,
      });

      const client = await signIn(email);
      const { data, error } = await client.rpc('get_report_top_products', {
        p_from: new Date(Date.now() - 10 * 86_400_000).toISOString(),
        p_merchant_id: merchantAccountId,
        p_shop_id: shopA,
        p_to: new Date(Date.now() + 86_400_000).toISOString(),
      });
      if (error) throw error;

      expect((data ?? []).find((row) => row.title === 'Produit A')).toBeTruthy();
      expect((data ?? []).find((row) => row.title === 'Produit B')).toBeUndefined();
    },
  );

  skipIfNoServiceRole('agent : accès refusé (garde de rôle, ni owner ni manager)', async () => {
    const { admin, merchantAccountId } = await createOwnerFixture('top-products-agent');
    await insertOrder(admin, merchantAccountId, {
      dimensions: LIVREE_DIMENSIONS,
      itemsSummary: [{ price: 1000, quantity: 1, title: 'Produit A' }],
      totalAmount: 1000,
    });
    const { email: agentEmail } = await addMember(admin, merchantAccountId, 'agent');
    const client = await signIn(agentEmail);

    const result = await client.rpc('get_report_top_products', {
      p_from: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      p_merchant_id: merchantAccountId,
      p_to: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(result.error).not.toBeNull();
  });

  skipIfNoServiceRole(
    'isolation tenant : owner du tenant B ne peut pas lire les produits du tenant A (rôle NULL)',
    async () => {
      const { admin, merchantAccountId: merchantA } = await createOwnerFixture('top-products-a');
      await insertOrder(admin, merchantA, {
        dimensions: LIVREE_DIMENSIONS,
        itemsSummary: [{ price: 1000, quantity: 1, title: 'Produit A' }],
        totalAmount: 1000,
      });
      const { email: emailB } = await createOwnerFixture('top-products-b');
      const clientB = await signIn(emailB);

      const result = await clientB.rpc('get_report_top_products', {
        p_from: new Date(Date.now() - 30 * 86_400_000).toISOString(),
        p_merchant_id: merchantA,
        p_to: new Date(Date.now() + 86_400_000).toISOString(),
      });
      expect(result.error).not.toBeNull();
    },
  );
});
