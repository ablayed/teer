/**
 * Migration 0132 — projection persistée de la fiabilité client.
 *
 * Ce que ces tests doivent prouver, et pourquoi chacun existe :
 *
 *  1. PARITÉ. `get_store_customer_reliability` n'est PAS modifiée par 0132 : elle reste
 *     l'implémentation de référence indépendante. Toute divergence entre elle et la
 *     projection est un bug de matérialisation, pas un désaccord d'opinion.
 *  2. INVALIDATION. Le score se périme sur ÉVÉNEMENT. Un chemin d'écriture non couvert ne
 *     produit AUCUNE erreur — il produit un chiffre faux, silencieusement. Chaque ligne du
 *     tableau d'audit de la section A a donc son test, pas un échantillon représentatif.
 *  3. ISOLATION. La projection est une nouvelle surface de lecture : elle doit refuser le
 *     non-membre, l'autre tenant et l'autre boutique exactement comme la RPC d'origine.
 *  4. CONCURRENCE. Deux écritures simultanées sur le même client sont l'anomalie que le
 *     verrou-avant-calcul de `refresh_customer_reliability_projection` existe pour éviter.
 */

import { randomUUID } from 'node:crypto';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestPostgresClient } from '../helpers/postgres-client';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const dbUrl =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const password = 'reliability-projection-rls-pw-0132';
const createdUserIds: string[] = [];

const runIf = serviceRoleKey ? it : it.skip;

type Client = SupabaseClient<Database>;

function adminClient(): Client {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createConfirmedUser(admin: Client, email: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('user creation failed');
  createdUserIds.push(data.user.id);
  return data.user.id;
}

async function waitForMerchantAccount(admin: Client, userId: string) {
  for (let i = 0; i < 20; i += 1) {
    const { data } = await admin
      .from('merchant_account')
      .select('id')
      .eq('owner_user_id', userId)
      .limit(1)
      .maybeSingle();
    if (data?.id) return data.id;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('merchant_account not found');
}

async function signIn(email: string): Promise<Client> {
  const client = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

async function defaultShopId(admin: Client, merchantAccountId: string) {
  const { data, error } = await admin
    .from('shop')
    .select('id')
    .eq('merchant_account_id', merchantAccountId)
    .eq('is_default', true)
    .single();
  if (error || !data) throw error ?? new Error('default shop not found');
  return data.id;
}

/** Boutique explicitement NON par défaut : c'est elle qui révèle un repli. */
async function createSecondaryShop(admin: Client, merchantAccountId: string) {
  const { data, error } = await admin
    .from('shop')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_domain: `reliability-${Date.now()}-${randomUUID()}.internal`,
      access_token_encrypted: 'enc',
      scopes: 'read_orders',
    })
    .select('id, is_default')
    .single();
  if (error || !data) throw error ?? new Error('secondary shop insert failed');
  expect(data.is_default).toBe(false);

  const { error: memberError } = await admin.from('shop_member').insert({
    merchant_account_id: merchantAccountId,
    shop_id: data.id,
    user_id: (
      await admin
        .from('merchant_account')
        .select('owner_user_id')
        .eq('id', merchantAccountId)
        .single()
    ).data?.owner_user_id as string,
    role: 'owner',
  });
  if (memberError && !memberError.message.includes('duplicate')) throw memberError;
  return data.id;
}

async function createTenant(label: string) {
  const admin = adminClient();
  const email = `reliability-${label}-${Date.now()}-${randomUUID()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  const defaultShop = await defaultShopId(admin, merchantAccountId);
  return { admin, email, userId, merchantAccountId, defaultShop };
}

async function createCustomer(
  admin: Client,
  merchantAccountId: string,
  shopId: string,
  fullName: string,
  phone?: string,
) {
  const { data, error } = await admin
    .from('customer')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      full_name: fullName,
      phone: phone ?? `+2217${Math.floor(Math.random() * 90000000 + 10000000)}`,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('customer insert failed');
  return data.id;
}

/** Dimensions → `cod_status` dérivé par trigger ; on n'écrit JAMAIS cod_status. */
const DIMENSIONS = {
  LIVREE: {
    order_state: 'open',
    call_state: 'validated',
    delivery_state: 'delivered',
    cash_state: 'collected',
  },
  REFUSEE: {
    order_state: 'open',
    call_state: 'validated',
    delivery_state: 'failed',
    cash_state: 'not_due',
  },
  ANNULEE: {
    order_state: 'cancelled',
    call_state: 'to_call',
    delivery_state: 'unassigned',
    cash_state: 'not_due',
  },
  A_APPELER: {
    order_state: 'open',
    call_state: 'to_call',
    delivery_state: 'unassigned',
    cash_state: 'not_due',
  },
} as const;

async function createOrder(
  admin: Client,
  merchantAccountId: string,
  shopId: string,
  customerId: string,
  status: keyof typeof DIMENSIONS,
  totalAmount = 10000,
  createdAt?: string,
) {
  const { data, error } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      customer_id: customerId,
      order_number: `REL-${Date.now()}-${randomUUID().slice(0, 8)}`,
      total_amount: totalAmount,
      currency: 'XOF',
      ...DIMENSIONS[status],
      ...(createdAt ? { created_at: createdAt } : {}),
    })
    .select('id, cod_status')
    .single();
  if (error || !data) throw error ?? new Error('order insert failed');
  return data;
}

async function createCallLog(
  admin: Client,
  merchantAccountId: string,
  shopId: string,
  orderId: string,
  agentUserId: string,
  outcome: 'CONFIRMEE' | 'SANS_REPONSE' | 'A_RAPPELER' | 'REFUSEE',
) {
  const { data, error } = await admin
    .from('call_log')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      order_id: orderId,
      agent_user_id: agentUserId,
      outcome,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('call_log insert failed');
  return data.id;
}

/**
 * Annulation attribuée à un acteur NON membre : c'est la seule forme qui alimente
 * `cancelled_count` (annulation imputée au client, pas au bureau).
 */
async function createOutsiderCancellation(
  admin: Client,
  merchantAccountId: string,
  shopId: string,
  orderId: string,
  outsiderUserId: string,
) {
  const { data, error } = await admin
    .from('order_state_transition')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      order_id: orderId,
      from_status: 'A_APPELER',
      to_status: 'ANNULEE',
      actor_user_id: outsiderUserId,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('transition insert failed');
  return data.id;
}

type ReliabilityRow =
  Database['public']['Functions']['list_store_customer_reliability']['Returns'][number];

async function listCustomers(
  client: Client,
  merchantAccountId: string,
  shopId: string,
  options: { search?: string; limit?: number; offset?: number; sortByRisk?: boolean } = {},
) {
  const { data, error } = await client.rpc('list_store_customer_reliability', {
    p_merchant_id: merchantAccountId,
    p_shop_id: shopId,
    p_search: options.search,
    p_limit: options.limit ?? 50,
    p_offset: options.offset ?? 0,
    p_sort_by_risk: options.sortByRisk ?? false,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as ReliabilityRow[];
}

async function oracle(
  client: Client,
  merchantAccountId: string,
  shopId: string,
  customerId: string,
) {
  const { data, error } = await client.rpc('get_store_customer_reliability', {
    p_merchant_id: merchantAccountId,
    p_shop_id: shopId,
    p_customer_id: customerId,
  });
  if (error) throw new Error(error.message);
  return (data ?? [])[0] as ReliabilityRow | undefined;
}

async function projectionRow(admin: Client, customerId: string) {
  const { data, error } = await admin
    .from('customer_reliability_projection')
    .select('*')
    .eq('customer_id', customerId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

afterAll(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  for (const userId of createdUserIds) {
    await admin.auth.admin.deleteUser(userId);
  }
  createdUserIds.length = 0;
});

describe('0132 — parité avec l implémentation de référence', () => {
  runIf(
    'la projection reproduit get_store_customer_reliability sur une activité mixte',
    async () => {
      const t = await createTenant('parity');
      const outsider = await createTenant('parity-outsider');
      const customerId = await createCustomer(
        t.admin,
        t.merchantAccountId,
        t.defaultShop,
        'Awa Diop',
      );

      await createOrder(t.admin, t.merchantAccountId, t.defaultShop, customerId, 'LIVREE', 25000);
      await createOrder(t.admin, t.merchantAccountId, t.defaultShop, customerId, 'LIVREE', 15000);
      await createOrder(t.admin, t.merchantAccountId, t.defaultShop, customerId, 'REFUSEE', 9000);
      const cancelled = await createOrder(
        t.admin,
        t.merchantAccountId,
        t.defaultShop,
        customerId,
        'ANNULEE',
      );
      await createOutsiderCancellation(
        t.admin,
        t.merchantAccountId,
        t.defaultShop,
        cancelled.id,
        outsider.userId,
      );
      const called = await createOrder(
        t.admin,
        t.merchantAccountId,
        t.defaultShop,
        customerId,
        'A_APPELER',
      );
      await createCallLog(
        t.admin,
        t.merchantAccountId,
        t.defaultShop,
        called.id,
        t.userId,
        'CONFIRMEE',
      );
      await createCallLog(
        t.admin,
        t.merchantAccountId,
        t.defaultShop,
        called.id,
        t.userId,
        'SANS_REPONSE',
      );

      const session = await signIn(t.email);
      const [listed] = await listCustomers(session, t.merchantAccountId, t.defaultShop);
      const reference = await oracle(session, t.merchantAccountId, t.defaultShop, customerId);

      expect(reference).toBeDefined();
      expect(listed.customer_id).toBe(customerId);

      // Champs entiers / booléens : égalité STRICTE, aucune tolérance.
      for (const key of [
        'decided',
        'delivered_count',
        'refused_count',
        'cancelled_count',
        'order_count',
        'score',
        'tier',
        'is_provisional',
        'flag_confirms_then_refuses',
        'flag_hard_to_reach',
        'flag_cancels_often',
      ] as const) {
        expect({ key, value: listed[key] }).toEqual({ key, value: reference?.[key] });
      }

      expect(Number(listed.delivered_lifetime)).toBe(Number(reference?.delivered_lifetime));

      // Sommes pondérées : comparaison RELATIVE, et non à 1e-16, parce que ces deux
      // appels sont deux requêtes HTTP distinctes évaluées à des `now()` différents.
      // La décroissance est réelle et continue (demi-vie 180 j), soit ~4.4e-8 par
      // seconde en relatif : quelques dizaines de millisecondes d'écart produisent
      // légitimement ~1e-9. Ce n'est pas du bruit de matérialisation — l'exactitude à
      // instant CONSTANT est prouvée par le test « même instant » ci-dessous.
      for (const key of [
        'delivered_weighted',
        'refused_weighted',
        'confirmed_weighted',
        'attempts_weighted',
        'no_response_weighted',
        'delivery_score',
        'confirm_score',
      ] as const) {
        const actual = Number(listed[key] ?? 0);
        const expected = Number(reference?.[key] ?? 0);
        const relative =
          expected === 0 ? Math.abs(actual) : Math.abs(actual - expected) / Math.abs(expected);
        expect({ key, within: relative < 1e-6 }).toEqual({ key, within: true });
      }
    },
  );

  runIf('à instant CONSTANT, la projection est exacte au 1e-12 près', async () => {
    const t = await createTenant('parity-exact');
    const outsider = await createTenant('parity-exact-outsider');

    for (let i = 0; i < 25; i += 1) {
      const customerId = await createCustomer(
        t.admin,
        t.merchantAccountId,
        t.defaultShop,
        `Exact ${String(i).padStart(3, '0')}`,
      );
      for (let d = 0; d < i % 5; d += 1) {
        await createOrder(
          t.admin,
          t.merchantAccountId,
          t.defaultShop,
          customerId,
          'LIVREE',
          5000 + i,
        );
      }
      for (let r = 0; r < i % 3; r += 1) {
        await createOrder(t.admin, t.merchantAccountId, t.defaultShop, customerId, 'REFUSEE');
      }
      if (i % 4 === 0) {
        const cancelled = await createOrder(
          t.admin,
          t.merchantAccountId,
          t.defaultShop,
          customerId,
          'ANNULEE',
        );
        await createOutsiderCancellation(
          t.admin,
          t.merchantAccountId,
          t.defaultShop,
          cancelled.id,
          outsider.userId,
        );
      }
      if (i % 2 === 0) {
        const called = await createOrder(
          t.admin,
          t.merchantAccountId,
          t.defaultShop,
          customerId,
          'A_APPELER',
        );
        await createCallLog(
          t.admin,
          t.merchantAccountId,
          t.defaultShop,
          called.id,
          t.userId,
          i % 4 === 0 ? 'CONFIRMEE' : 'SANS_REPONSE',
        );
      }
    }

    // Une SEULE requête : les deux côtés partagent le même `now()`, donc tout écart
    // restant est imputable à la reconstruction ancrée, et à rien d'autre.
    const pg = createTestPostgresClient(dbUrl);
    await pg.connect();
    try {
      await pg.query(`select set_config('request.jwt.claim.sub', $1, false)`, [t.userId]);
      const { rows } = await pg.query(
        `with oracle as (
           select r.*
           from public.customer c
           cross join lateral public.get_store_customer_reliability($1, $2, c.id) r
           where c.merchant_account_id = $1 and c.shop_id = $2
         ),
         proj as (
           select v.* from public.customer_reliability_scored v
           where v.merchant_account_id = $1 and v.shop_id = $2
         )
         select
           count(*)::int as compared,
           count(*) filter (where o.score is distinct from p.score)::int as score_mismatch,
           count(*) filter (where o.tier is distinct from p.tier)::int as tier_mismatch,
           count(*) filter (where o.decided is distinct from p.decided)::int as decided_mismatch,
           count(*) filter (where o.order_count is distinct from p.order_count)::int as order_mismatch,
           count(*) filter (where o.cancelled_count is distinct from p.cancelled_count)::int as cancelled_mismatch,
           count(*) filter (where o.delivered_lifetime is distinct from p.delivered_lifetime)::int as lifetime_mismatch,
           count(*) filter (where o.flag_confirms_then_refuses is distinct from p.flag_confirms_then_refuses
             or o.flag_hard_to_reach is distinct from p.flag_hard_to_reach
             or o.flag_cancels_often is distinct from p.flag_cancels_often)::int as flag_mismatch,
           coalesce(max(abs(o.delivered_weighted - p.delivered_weighted)), 0)::float8 as max_delivered_delta,
           coalesce(max(abs(o.attempts_weighted - p.attempts_weighted)), 0)::float8 as max_attempts_delta,
           coalesce(max(abs(o.delivery_score - p.delivery_score)), 0)::float8 as max_delivery_score_delta
         from oracle o join proj p on p.customer_id = o.customer_id`,
        [t.merchantAccountId, t.defaultShop],
      );
      const r = rows[0];
      expect(r.compared).toBe(25);
      expect({
        score: r.score_mismatch,
        tier: r.tier_mismatch,
        decided: r.decided_mismatch,
        order: r.order_mismatch,
        cancelled: r.cancelled_mismatch,
        lifetime: r.lifetime_mismatch,
        flags: r.flag_mismatch,
      }).toEqual({
        score: 0,
        tier: 0,
        decided: 0,
        order: 0,
        cancelled: 0,
        lifetime: 0,
        flags: 0,
      });
      expect(r.max_delivered_delta).toBeLessThan(1e-12);
      expect(r.max_attempts_delta).toBeLessThan(1e-12);
      expect(r.max_delivery_score_delta).toBeLessThan(1e-12);
    } finally {
      await pg.end();
    }
  });

  runIf('un client sans aucune activité vaut 70 / « new », sans ligne fantôme', async () => {
    const t = await createTenant('empty-customer');
    const customerId = await createCustomer(
      t.admin,
      t.merchantAccountId,
      t.defaultShop,
      'Client Sans Commande',
    );

    const session = await signIn(t.email);
    const [listed] = await listCustomers(session, t.merchantAccountId, t.defaultShop);
    const reference = await oracle(session, t.merchantAccountId, t.defaultShop, customerId);

    expect(listed.score).toBe(70);
    expect(listed.tier).toBe('new');
    expect(listed.order_count).toBe(0);
    expect(listed.score).toBe(reference?.score);
  });

  runIf('un tenant sans client renvoie une liste vide, pas une erreur', async () => {
    const t = await createTenant('empty-tenant');
    const session = await signIn(t.email);
    const rows = await listCustomers(session, t.merchantAccountId, t.defaultShop);
    expect(rows).toEqual([]);
  });
});

describe('0132 — catégories de score et bornes', () => {
  runIf('new / reliable / watch / risk et le palier provisoire', async () => {
    const t = await createTenant('tiers');
    const session = await signIn(t.email);

    // « new » : moins de 3 commandes décidées.
    const newbie = await createCustomer(t.admin, t.merchantAccountId, t.defaultShop, 'A Nouveau');
    await createOrder(t.admin, t.merchantAccountId, t.defaultShop, newbie, 'LIVREE');
    await createOrder(t.admin, t.merchantAccountId, t.defaultShop, newbie, 'LIVREE');

    // « reliable » : livraisons only, décidées >= 3.
    const reliable = await createCustomer(t.admin, t.merchantAccountId, t.defaultShop, 'B Fiable');
    for (let i = 0; i < 6; i += 1) {
      await createOrder(t.admin, t.merchantAccountId, t.defaultShop, reliable, 'LIVREE');
    }

    // « risk » : refus massifs.
    const risky = await createCustomer(t.admin, t.merchantAccountId, t.defaultShop, 'C Risque');
    for (let i = 0; i < 12; i += 1) {
      await createOrder(t.admin, t.merchantAccountId, t.defaultShop, risky, 'REFUSEE');
    }

    // Palier provisoire : exactement 3 ou 4 décidées.
    const provisional = await createCustomer(
      t.admin,
      t.merchantAccountId,
      t.defaultShop,
      'D Provisoire',
    );
    for (let i = 0; i < 3; i += 1) {
      await createOrder(t.admin, t.merchantAccountId, t.defaultShop, provisional, 'LIVREE');
    }

    const rows = await listCustomers(session, t.merchantAccountId, t.defaultShop);
    const byId = new Map(rows.map((r) => [r.customer_id, r]));

    expect(byId.get(newbie)?.tier).toBe('new');
    expect(byId.get(newbie)?.is_provisional).toBe(false);
    expect(byId.get(reliable)?.tier).toBe('reliable');
    expect(byId.get(reliable)?.score).toBeGreaterThanOrEqual(75);
    expect(byId.get(risky)?.tier).toBe('risk');
    expect(byId.get(risky)?.score).toBeLessThan(50);
    expect(byId.get(provisional)?.is_provisional).toBe(true);
    expect(byId.get(provisional)?.decided).toBe(3);

    // Et chacun reste conforme à l'implémentation de référence.
    for (const id of [newbie, reliable, risky, provisional]) {
      const reference = await oracle(session, t.merchantAccountId, t.defaultShop, id);
      expect({ id, tier: byId.get(id)?.tier, score: byId.get(id)?.score }).toEqual({
        id,
        tier: reference?.tier,
        score: reference?.score,
      });
    }
  });

  runIf('flag_cancels_often suit les annulations imputées au client', async () => {
    const t = await createTenant('flags');
    const outsider = await createTenant('flags-outsider');
    const customerId = await createCustomer(
      t.admin,
      t.merchantAccountId,
      t.defaultShop,
      'E Annule',
    );

    for (let i = 0; i < 5; i += 1) {
      const order = await createOrder(
        t.admin,
        t.merchantAccountId,
        t.defaultShop,
        customerId,
        'ANNULEE',
      );
      await createOutsiderCancellation(
        t.admin,
        t.merchantAccountId,
        t.defaultShop,
        order.id,
        outsider.userId,
      );
    }
    await createOrder(t.admin, t.merchantAccountId, t.defaultShop, customerId, 'LIVREE');

    const session = await signIn(t.email);
    const [row] = await listCustomers(session, t.merchantAccountId, t.defaultShop);
    expect(row.cancelled_count).toBe(5);
    expect(row.flag_cancels_often).toBe(true);
  });
});

describe('0132 — classement global par risque', () => {
  runIf('le tri par risque est global, pas limité à la page courante', async () => {
    const t = await createTenant('ranking');
    const session = await signIn(t.email);

    // 12 clients dont le score DÉCROÎT quand le nom CROÎT : si le tri par risque
    // n'était appliqué qu'à la page courante, la page 1 (triée par nom) remonterait
    // les meilleurs scores au lieu des pires.
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const id = await createCustomer(
        t.admin,
        t.merchantAccountId,
        t.defaultShop,
        `Rang ${String(i).padStart(2, '0')}`,
      );
      ids.push(id);
      for (let d = 0; d < 12 - i; d += 1) {
        await createOrder(t.admin, t.merchantAccountId, t.defaultShop, id, 'LIVREE');
      }
      for (let r = 0; r < i; r += 1) {
        await createOrder(t.admin, t.merchantAccountId, t.defaultShop, id, 'REFUSEE');
      }
    }

    const page1 = await listCustomers(session, t.merchantAccountId, t.defaultShop, {
      sortByRisk: true,
      limit: 5,
      offset: 0,
    });
    const page2 = await listCustomers(session, t.merchantAccountId, t.defaultShop, {
      sortByRisk: true,
      limit: 5,
      offset: 5,
    });
    const page3 = await listCustomers(session, t.merchantAccountId, t.defaultShop, {
      sortByRisk: true,
      limit: 5,
      offset: 10,
    });

    const all = [...page1, ...page2, ...page3];
    expect(all).toHaveLength(12);
    expect(new Set(all.map((r) => r.customer_id)).size).toBe(12);

    const rank = (r: ReliabilityRow) =>
      ({ risk: 0, watch: 1, new: 2, reliable: 3 })[
        r.tier as 'risk' | 'watch' | 'new' | 'reliable'
      ] ?? 4;
    for (let i = 1; i < all.length; i += 1) {
      const previous = all[i - 1];
      const current = all[i];
      const ordered =
        rank(previous) < rank(current) ||
        (rank(previous) === rank(current) && previous.score <= current.score);
      expect({ i, ordered }).toEqual({ i, ordered: true });
    }

    // La page 1 contient bien les PIRES, pas les premiers par ordre alphabétique.
    expect(page1[0].score).toBeLessThanOrEqual(page3[page3.length - 1].score);
  });

  runIf('recherche et tri par risque se combinent sans perdre le classement', async () => {
    const t = await createTenant('search-risk');
    const session = await signIn(t.email);

    const target: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const id = await createCustomer(
        t.admin,
        t.merchantAccountId,
        t.defaultShop,
        `Ndiaye ${String(i)}`,
      );
      target.push(id);
      for (let d = 0; d < 6 - i; d += 1) {
        await createOrder(t.admin, t.merchantAccountId, t.defaultShop, id, 'LIVREE');
      }
      for (let r = 0; r < i * 3; r += 1) {
        await createOrder(t.admin, t.merchantAccountId, t.defaultShop, id, 'REFUSEE');
      }
    }
    const other = await createCustomer(t.admin, t.merchantAccountId, t.defaultShop, 'Fall Autre');
    for (let r = 0; r < 20; r += 1) {
      await createOrder(t.admin, t.merchantAccountId, t.defaultShop, other, 'REFUSEE');
    }

    const rows = await listCustomers(session, t.merchantAccountId, t.defaultShop, {
      search: 'Ndiaye',
      sortByRisk: true,
    });

    // Le filtre s'applique AVANT le classement : le pire client du tenant est exclu
    // par la recherche et ne doit pas apparaître en tête.
    expect(rows.map((r) => r.customer_id).sort()).toEqual([...target].sort());
    expect(rows.some((r) => r.customer_id === other)).toBe(false);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i - 1].score).toBeLessThanOrEqual(rows[i].score);
    }
  });

  runIf('les égalités sont départagées de façon déterministe et reproductible', async () => {
    const t = await createTenant('ties');
    const session = await signIn(t.email);

    // Même nom ET même activité → seul customer_id peut départager.
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const id = await createCustomer(t.admin, t.merchantAccountId, t.defaultShop, 'Homonyme');
      ids.push(id);
      for (let d = 0; d < 4; d += 1) {
        await createOrder(t.admin, t.merchantAccountId, t.defaultShop, id, 'LIVREE');
      }
    }

    const first = await listCustomers(session, t.merchantAccountId, t.defaultShop, {
      sortByRisk: true,
    });
    const second = await listCustomers(session, t.merchantAccountId, t.defaultShop, {
      sortByRisk: true,
    });
    const byName = await listCustomers(session, t.merchantAccountId, t.defaultShop);

    expect(first.map((r) => r.customer_id)).toEqual(second.map((r) => r.customer_id));
    expect(first.map((r) => r.customer_id)).toEqual([...ids].sort());
    expect(byName.map((r) => r.customer_id)).toEqual([...ids].sort());

    // Pagination sans recouvrement ni trou sur des égalités parfaites.
    const p1 = await listCustomers(session, t.merchantAccountId, t.defaultShop, {
      sortByRisk: true,
      limit: 2,
      offset: 0,
    });
    const p2 = await listCustomers(session, t.merchantAccountId, t.defaultShop, {
      sortByRisk: true,
      limit: 2,
      offset: 2,
    });
    expect(new Set([...p1, ...p2].map((r) => r.customer_id)).size).toBe(4);
  });
});

describe('0132 — invalidation par événement', () => {
  runIf('création de commande', async () => {
    const t = await createTenant('inv-order-insert');
    const session = await signIn(t.email);
    const customerId = await createCustomer(t.admin, t.merchantAccountId, t.defaultShop, 'Inv A');

    const before = await projectionRow(t.admin, customerId);
    expect(before?.order_count).toBe(0);

    await createOrder(t.admin, t.merchantAccountId, t.defaultShop, customerId, 'LIVREE', 12000);

    const after = await projectionRow(t.admin, customerId);
    expect(after?.order_count).toBe(1);
    expect(after?.delivered_count).toBe(1);
    expect(Number(after?.delivered_lifetime)).toBe(12000);

    const [row] = await listCustomers(session, t.merchantAccountId, t.defaultShop);
    const reference = await oracle(session, t.merchantAccountId, t.defaultShop, customerId);
    expect(row.score).toBe(reference?.score);
  });

  runIf('changement de statut par le VRAI chemin transition_order', async () => {
    const t = await createTenant('inv-transition');
    const session = await signIn(t.email);
    const customerId = await createCustomer(t.admin, t.merchantAccountId, t.defaultShop, 'Inv B');
    const order = await createOrder(
      t.admin,
      t.merchantAccountId,
      t.defaultShop,
      customerId,
      'A_APPELER',
    );

    expect((await projectionRow(t.admin, customerId))?.delivered_count).toBe(0);

    // 0148 — transition_order confronte désormais p_actor à auth.uid() : le
    // service-role (t.admin) n'a pas de session, auth.uid() y est nul, l'appel
    // serait refusé (forbidden). Le VRAI chemin de production passe toujours
    // par une session utilisateur (lib/actions/transitions.ts) — router ce test
    // par `session` (déjà signée pour t.email ci-dessus) le rend fidèle à ce
    // qu'il annonce tester, plutôt qu'un raccourci que 0148 a révélé.
    const rpc = session.rpc.bind(session) as unknown as (
      fn: 'transition_order',
      args: Record<string, unknown>,
    ) => Promise<{ error: { message: string } | null }>;
    const { error } = await rpc('transition_order', {
      p_order_id: order.id,
      p_actor: t.userId,
      p_call_state: 'validated',
      p_delivery_state: 'delivered',
      p_cash_state: 'collected',
    });
    expect(error).toBeNull();

    const after = await projectionRow(t.admin, customerId);
    expect(after?.delivered_count).toBe(1);

    const reference = await oracle(session, t.merchantAccountId, t.defaultShop, customerId);
    const [row] = await listCustomers(session, t.merchantAccountId, t.defaultShop);
    expect(row.score).toBe(reference?.score);
    expect(row.delivered_count).toBe(1);
  });

  runIf('suppression de commande', async () => {
    const t = await createTenant('inv-order-delete');
    const customerId = await createCustomer(t.admin, t.merchantAccountId, t.defaultShop, 'Inv C');
    const order = await createOrder(
      t.admin,
      t.merchantAccountId,
      t.defaultShop,
      customerId,
      'LIVREE',
    );
    expect((await projectionRow(t.admin, customerId))?.order_count).toBe(1);

    await t.admin.from('orders').delete().eq('id', order.id);
    expect((await projectionRow(t.admin, customerId))?.order_count).toBe(0);
  });

  runIf('journal d appel : insertion puis suppression', async () => {
    const t = await createTenant('inv-call');
    const session = await signIn(t.email);
    const customerId = await createCustomer(t.admin, t.merchantAccountId, t.defaultShop, 'Inv D');
    const order = await createOrder(
      t.admin,
      t.merchantAccountId,
      t.defaultShop,
      customerId,
      'A_APPELER',
    );

    expect(Number((await projectionRow(t.admin, customerId))?.attempts_anchor)).toBe(0);

    const callId = await createCallLog(
      t.admin,
      t.merchantAccountId,
      t.defaultShop,
      order.id,
      t.userId,
      'CONFIRMEE',
    );
    const afterInsert = await projectionRow(t.admin, customerId);
    expect(Number(afterInsert?.attempts_anchor)).toBeGreaterThan(0);
    expect(Number(afterInsert?.confirmed_anchor)).toBeGreaterThan(0);

    const reference = await oracle(session, t.merchantAccountId, t.defaultShop, customerId);
    const [row] = await listCustomers(session, t.merchantAccountId, t.defaultShop);
    expect(row.score).toBe(reference?.score);

    await t.admin.from('call_log').delete().eq('id', callId);
    expect(Number((await projectionRow(t.admin, customerId))?.attempts_anchor)).toBe(0);
  });

  runIf('journal d appel : mise à jour du résultat', async () => {
    const t = await createTenant('inv-call-update');
    const customerId = await createCustomer(t.admin, t.merchantAccountId, t.defaultShop, 'Inv E');
    const order = await createOrder(
      t.admin,
      t.merchantAccountId,
      t.defaultShop,
      customerId,
      'A_APPELER',
    );
    const callId = await createCallLog(
      t.admin,
      t.merchantAccountId,
      t.defaultShop,
      order.id,
      t.userId,
      'CONFIRMEE',
    );

    expect(Number((await projectionRow(t.admin, customerId))?.no_response_anchor)).toBe(0);

    await t.admin.from('call_log').update({ outcome: 'SANS_REPONSE' }).eq('id', callId);

    const after = await projectionRow(t.admin, customerId);
    expect(Number(after?.no_response_anchor)).toBeGreaterThan(0);
    expect(Number(after?.confirmed_anchor)).toBe(0);
  });

  runIf('transition ANNULEE : insertion puis suppression', async () => {
    const t = await createTenant('inv-cancel');
    const outsider = await createTenant('inv-cancel-outsider');
    const customerId = await createCustomer(t.admin, t.merchantAccountId, t.defaultShop, 'Inv F');
    const order = await createOrder(
      t.admin,
      t.merchantAccountId,
      t.defaultShop,
      customerId,
      'ANNULEE',
    );

    expect((await projectionRow(t.admin, customerId))?.cancelled_count).toBe(0);

    const transitionId = await createOutsiderCancellation(
      t.admin,
      t.merchantAccountId,
      t.defaultShop,
      order.id,
      outsider.userId,
    );
    expect((await projectionRow(t.admin, customerId))?.cancelled_count).toBe(1);

    await t.admin.from('order_state_transition').delete().eq('id', transitionId);
    expect((await projectionRow(t.admin, customerId))?.cancelled_count).toBe(0);
  });

  runIf('appartenance : ajouter le membre requalifie rétroactivement ses annulations', async () => {
    const t = await createTenant('inv-member');
    const guest = await createTenant('inv-member-guest');
    const customerId = await createCustomer(t.admin, t.merchantAccountId, t.defaultShop, 'Inv G');
    const order = await createOrder(
      t.admin,
      t.merchantAccountId,
      t.defaultShop,
      customerId,
      'ANNULEE',
    );
    await createOutsiderCancellation(
      t.admin,
      t.merchantAccountId,
      t.defaultShop,
      order.id,
      guest.userId,
    );

    // Acteur non membre → annulation imputée au client.
    expect((await projectionRow(t.admin, customerId))?.cancelled_count).toBe(1);

    // L'acteur rejoint l'organisation : la même annulation devient interne.
    // `enforce_single_organization_membership` impose de retirer d'abord son
    // appartenance d'origine.
    await t.admin.from('merchant_member').delete().eq('user_id', guest.userId);
    const { error: joinError } = await t.admin.from('merchant_member').insert({
      merchant_account_id: t.merchantAccountId,
      user_id: guest.userId,
      role: 'agent',
    });
    expect(joinError).toBeNull();

    expect((await projectionRow(t.admin, customerId))?.cancelled_count).toBe(0);

    // Et son départ la rend de nouveau imputable au client.
    await t.admin
      .from('merchant_member')
      .delete()
      .eq('user_id', guest.userId)
      .eq('merchant_account_id', t.merchantAccountId);

    expect((await projectionRow(t.admin, customerId))?.cancelled_count).toBe(1);
  });

  runIf('création de client : la ligne de projection existe immédiatement', async () => {
    const t = await createTenant('inv-customer');
    const customerId = await createCustomer(t.admin, t.merchantAccountId, t.defaultShop, 'Inv H');
    const row = await projectionRow(t.admin, customerId);
    expect(row).not.toBeNull();
    expect(row?.order_count).toBe(0);
    expect(row?.computed_at).toBeTruthy();
  });

  runIf('renommer un client change la liste sans rafraîchir la projection', async () => {
    const t = await createTenant('inv-rename');
    const session = await signIn(t.email);
    const customerId = await createCustomer(
      t.admin,
      t.merchantAccountId,
      t.defaultShop,
      'Ancien Nom',
    );
    const before = await projectionRow(t.admin, customerId);

    await t.admin.from('customer').update({ full_name: 'Nouveau Nom' }).eq('id', customerId);

    const [row] = await listCustomers(session, t.merchantAccountId, t.defaultShop);
    expect(row.full_name).toBe('Nouveau Nom');
    // Le nom est lu en direct depuis `customer` : aucun recalcul n'est nécessaire,
    // donc `computed_at` ne doit PAS bouger. C'est ce qui garantit qu'un simple
    // renommage ne coûte rien.
    const after = await projectionRow(t.admin, customerId);
    expect(after?.computed_at).toBe(before?.computed_at);
  });

  runIf('computed_at avance à chaque rafraîchissement et reste interrogeable', async () => {
    const t = await createTenant('freshness');
    const customerId = await createCustomer(t.admin, t.merchantAccountId, t.defaultShop, 'Inv I');
    const first = await projectionRow(t.admin, customerId);

    await new Promise((r) => setTimeout(r, 25));
    await createOrder(t.admin, t.merchantAccountId, t.defaultShop, customerId, 'LIVREE');
    const second = await projectionRow(t.admin, customerId);

    expect(new Date(second?.computed_at ?? 0).getTime()).toBeGreaterThan(
      new Date(first?.computed_at ?? 0).getTime(),
    );

    // Interrogeable pour un futur audit de péremption.
    const { data, error } = await t.admin
      .from('customer_reliability_projection')
      .select('customer_id, computed_at')
      .eq('merchant_account_id', t.merchantAccountId)
      .order('computed_at', { ascending: true });
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  runIf('la reconstruction complète est idempotente et rejouable', async () => {
    const t = await createTenant('idempotent');
    const customerId = await createCustomer(t.admin, t.merchantAccountId, t.defaultShop, 'Inv J');
    await createOrder(t.admin, t.merchantAccountId, t.defaultShop, customerId, 'LIVREE', 30000);
    await createOrder(t.admin, t.merchantAccountId, t.defaultShop, customerId, 'REFUSEE');

    const before = await projectionRow(t.admin, customerId);

    const rebuild = t.admin.rpc.bind(t.admin) as unknown as (
      fn: 'rebuild_customer_reliability_projection',
      args: { p_batch_size: number },
    ) => Promise<{ data: unknown; error: { message: string } | null }>;

    const first = await rebuild('rebuild_customer_reliability_projection', { p_batch_size: 2 });
    expect(first.error).toBeNull();
    const second = await rebuild('rebuild_customer_reliability_projection', { p_batch_size: 2 });
    expect(second.error).toBeNull();

    const after = await projectionRow(t.admin, customerId);
    for (const key of [
      'order_count',
      'delivered_count',
      'refused_count',
      'cancelled_count',
    ] as const) {
      expect({ key, value: after?.[key] }).toEqual({ key, value: before?.[key] });
    }
    expect(Number(after?.delivered_lifetime)).toBe(Number(before?.delivered_lifetime));
    // Les ancres sont invariantes dans le temps : un rebuild ne doit PAS les bouger.
    expect(Number(after?.delivered_anchor)).toBeCloseTo(Number(before?.delivered_anchor), 10);
  });
});

describe('0132 — concurrence', () => {
  runIf(
    'deux commandes insérées simultanément pour le même client sont toutes deux comptées',
    async () => {
      const t = await createTenant('concurrency');
      const customerId = await createCustomer(
        t.admin,
        t.merchantAccountId,
        t.defaultShop,
        'Conc A',
      );

      const a = createTestPostgresClient(dbUrl);
      const b = createTestPostgresClient(dbUrl);
      await a.connect();
      await b.connect();

      const insert = (orderNumber: string) => `
        insert into public.orders (merchant_account_id, shop_id, customer_id, order_number,
          total_amount, currency, order_state, call_state, delivery_state, cash_state)
        values ('${t.merchantAccountId}', '${t.defaultShop}', '${customerId}', '${orderNumber}',
          10000, 'XOF', 'open', 'validated', 'delivered', 'collected')`;

      try {
        await a.query('begin');
        await b.query('begin');

        // A insère et son trigger prend le verrou de la ligne de projection.
        await a.query(insert(`CONC-A-${randomUUID().slice(0, 8)}`));

        // B insère : son trigger doit ATTENDRE ce verrou, puis recalculer sur un
        // instantané neuf. Sans le verrou-avant-calcul, B compterait 1 et écraserait
        // le 1 de A — total faux de 1 au lieu de 2, sans aucune erreur.
        const pendingB = b.query(insert(`CONC-B-${randomUUID().slice(0, 8)}`));

        await a.query('commit');
        await pendingB;
        await b.query('commit');
      } finally {
        await a.end();
        await b.end();
      }

      const row = await projectionRow(t.admin, customerId);
      expect(row?.order_count).toBe(2);
      expect(row?.delivered_count).toBe(2);
    },
  );
});

describe('0132 — isolation et permissions', () => {
  runIf('une boutique secondaire non-défaut a son propre score', async () => {
    const t = await createTenant('secondary');
    const secondary = await createSecondaryShop(t.admin, t.merchantAccountId);
    const session = await signIn(t.email);

    const defaultCustomer = await createCustomer(
      t.admin,
      t.merchantAccountId,
      t.defaultShop,
      'Boutique Defaut',
    );
    const secondaryCustomer = await createCustomer(
      t.admin,
      t.merchantAccountId,
      secondary,
      'Boutique Secondaire',
    );

    for (let i = 0; i < 6; i += 1) {
      await createOrder(t.admin, t.merchantAccountId, t.defaultShop, defaultCustomer, 'LIVREE');
    }
    for (let i = 0; i < 8; i += 1) {
      await createOrder(t.admin, t.merchantAccountId, secondary, secondaryCustomer, 'REFUSEE');
    }

    const defaultRows = await listCustomers(session, t.merchantAccountId, t.defaultShop);
    const secondaryRows = await listCustomers(session, t.merchantAccountId, secondary);

    expect(defaultRows.map((r) => r.customer_id)).toEqual([defaultCustomer]);
    expect(secondaryRows.map((r) => r.customer_id)).toEqual([secondaryCustomer]);
    expect(defaultRows[0].tier).toBe('reliable');
    expect(secondaryRows[0].tier).toBe('risk');

    // La ligne de projection porte bien la boutique du client, jamais celle par défaut.
    const projected = await projectionRow(t.admin, secondaryCustomer);
    expect(projected?.shop_id).toBe(secondary);
    expect(projected?.shop_id).not.toBe(t.defaultShop);
  });

  runIf(
    'des clients homonymes et de même téléphone ne se mélangent pas entre boutiques',
    async () => {
      const t = await createTenant('homonym');
      const secondary = await createSecondaryShop(t.admin, t.merchantAccountId);
      const session = await signIn(t.email);

      const phone = `+2217${Math.floor(Math.random() * 90000000 + 10000000)}`;
      const inDefault = await createCustomer(
        t.admin,
        t.merchantAccountId,
        t.defaultShop,
        'Meme Personne',
        phone,
      );
      const inSecondary = await createCustomer(
        t.admin,
        t.merchantAccountId,
        secondary,
        'Meme Personne',
        phone,
      );

      for (let i = 0; i < 5; i += 1) {
        await createOrder(t.admin, t.merchantAccountId, t.defaultShop, inDefault, 'LIVREE');
      }
      for (let i = 0; i < 9; i += 1) {
        await createOrder(t.admin, t.merchantAccountId, secondary, inSecondary, 'REFUSEE');
      }

      const defaultRows = await listCustomers(session, t.merchantAccountId, t.defaultShop, {
        search: 'Meme Personne',
      });
      const secondaryRows = await listCustomers(session, t.merchantAccountId, secondary, {
        search: 'Meme Personne',
      });

      expect(defaultRows).toHaveLength(1);
      expect(secondaryRows).toHaveLength(1);
      expect(defaultRows[0].customer_id).toBe(inDefault);
      expect(secondaryRows[0].customer_id).toBe(inSecondary);
      expect(defaultRows[0].delivered_count).toBe(5);
      expect(secondaryRows[0].refused_count).toBe(9);
      expect(defaultRows[0].score).not.toBe(secondaryRows[0].score);
    },
  );

  runIf('aucune fuite entre deux tenants', async () => {
    const a = await createTenant('tenant-a');
    const b = await createTenant('tenant-b');
    const customerA = await createCustomer(a.admin, a.merchantAccountId, a.defaultShop, 'Chez A');
    await createOrder(a.admin, a.merchantAccountId, a.defaultShop, customerA, 'LIVREE');

    const sessionB = await signIn(b.email);

    // La boutique de A n'est pas lisible par B.
    const crossShop = await listCustomers(sessionB, a.merchantAccountId, a.defaultShop);
    expect(crossShop).toEqual([]);

    // Et sa propre boutique ne contient pas le client de A.
    const own = await listCustomers(sessionB, b.merchantAccountId, b.defaultShop);
    expect(own.some((r) => r.customer_id === customerA)).toBe(false);

    // Lecture directe de la projection : RLS bloque aussi.
    const { data } = await sessionB
      .from('customer_reliability_projection')
      .select('customer_id')
      .eq('customer_id', customerA);
    expect(data ?? []).toEqual([]);
  });

  runIf('un non-membre de la boutique n obtient rien', async () => {
    const t = await createTenant('non-member');
    const secondary = await createSecondaryShop(t.admin, t.merchantAccountId);
    const customerId = await createCustomer(t.admin, t.merchantAccountId, secondary, 'Cache');
    await createOrder(t.admin, t.merchantAccountId, secondary, customerId, 'LIVREE');

    // Retirer l'appartenance à la boutique tout en gardant l'appartenance au tenant.
    await t.admin.from('shop_member').delete().eq('shop_id', secondary).eq('user_id', t.userId);

    const session = await signIn(t.email);
    expect(await listCustomers(session, t.merchantAccountId, secondary)).toEqual([]);

    const { data } = await session
      .from('customer_reliability_projection')
      .select('customer_id')
      .eq('shop_id', secondary);
    expect(data ?? []).toEqual([]);
  });

  runIf('une session anonyme est refusée', async () => {
    const t = await createTenant('anon');
    const anon = createClient<Database>(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error } = await anon.rpc('list_store_customer_reliability', {
      p_merchant_id: t.merchantAccountId,
      p_shop_id: t.defaultShop,
    });
    expect(error).not.toBeNull();
  });

  runIf('un utilisateur authentifié ne peut jamais écrire dans la projection', async () => {
    const t = await createTenant('write-guard');
    const customerId = await createCustomer(t.admin, t.merchantAccountId, t.defaultShop, 'Guard');
    await createOrder(t.admin, t.merchantAccountId, t.defaultShop, customerId, 'REFUSEE');
    const session = await signIn(t.email);

    // Fabriquer un score « fiable » depuis le client doit être impossible.
    const updated = await session
      .from('customer_reliability_projection')
      .update({ delivered_count: 999, delivered_anchor: 999 })
      .eq('customer_id', customerId);
    expect(updated.error).not.toBeNull();

    const inserted = await session.from('customer_reliability_projection').insert({
      merchant_account_id: t.merchantAccountId,
      shop_id: t.defaultShop,
      customer_id: customerId,
    });
    expect(inserted.error).not.toBeNull();

    const deleted = await session
      .from('customer_reliability_projection')
      .delete()
      .eq('customer_id', customerId);
    expect(deleted.error).not.toBeNull();

    // Et la valeur réelle est intacte.
    const row = await projectionRow(t.admin, customerId);
    expect(row?.delivered_count).toBe(0);
    expect(row?.refused_count).toBe(1);
  });

  runIf('la fonction de rafraîchissement n est pas exposée à une session utilisateur', async () => {
    const t = await createTenant('refresh-guard');
    const session = await signIn(t.email);
    const rpc = session.rpc.bind(session) as unknown as (
      fn: 'refresh_customer_reliability_projection',
      args: Record<string, unknown>,
    ) => Promise<{ error: { message: string } | null }>;
    const { error } = await rpc('refresh_customer_reliability_projection', {
      p_customer_ids: [],
    });
    expect(error).not.toBeNull();
  });
});

describe('0132 — garde de plan', () => {
  runIf('la page par nom pagine AVANT tout enrichissement', async () => {
    const t = await createTenant('plan-guard');

    const pg = createTestPostgresClient(dbUrl);
    await pg.connect();
    try {
      // Volume semé en SQL, pas via HTTP : il faut dépasser le point où un balayage
      // complet redevient plus économique qu'un parcours d'index. En dessous, le
      // planificateur choisit LÉGITIMEMENT de tout lire, et la garde mesurerait la
      // taille du jeu d'essai au lieu de la forme de la requête.
      await pg.query(
        `insert into public.customer (merchant_account_id, shop_id, full_name, phone)
         select $1, $2, 'Plan ' || lpad(g::text, 5, '0'), '+2217' || lpad(g::text, 8, '0')
         from generate_series(1, 800) g`,
        [t.merchantAccountId, t.defaultShop],
      );
      await pg.query(
        `insert into public.orders (merchant_account_id, shop_id, customer_id, order_number,
           total_amount, currency, order_state, call_state, delivery_state, cash_state)
         select $1, $2, c.id, 'PLAN-' || c.id, 10000, 'XOF',
                'open', 'validated', 'delivered', 'collected'
         from public.customer c
         where c.merchant_account_id = $1 and c.shop_id = $2`,
        [t.merchantAccountId, t.defaultShop],
      );

      await pg.query(`select set_config('request.jwt.claim.sub', $1, false)`, [t.userId]);
      await pg.query('analyze public.customer');
      await pg.query('analyze public.customer_reliability_projection');

      const result = await pg.query(
        `explain (analyze, buffers, costs off)
         select v.customer_id, v.full_name, v.score, v.tier
         from public.customer_reliability_scored v
         where v.merchant_account_id = $1 and v.shop_id = $2
         order by v.full_name asc nulls last, v.customer_id
         limit 10`,
        [t.merchantAccountId, t.defaultShop],
      );
      const plan = result.rows.map((r) => r['QUERY PLAN'] as string).join('\n');

      // 1. Plus aucune évaluation par client de la fonction de scoring.
      expect(plan).not.toMatch(/get_store_customer_reliability/);

      // 2. La pagination passe par l'index de nom, pas par un balayage complet.
      expect(plan).toMatch(/customer_tenant_shop_name_idx/);

      // 3. Le nœud qui lit `customer` ne remonte QUE la page demandée. C'est
      //    l'assertion qui rougit si le tri repasse au-dessus de l'enrichissement.
      const customerNode = plan
        .split('\n')
        .find((line) => line.includes('customer_tenant_shop_name_idx'));
      const scanned = Number(/rows=(\d+)/.exec(customerNode ?? '')?.[1] ?? Number.NaN);
      expect(scanned).toBeLessThanOrEqual(10);
    } finally {
      await pg.end();
    }
  });

  runIf('le tri par risque lit la projection et jamais la fonction par client', async () => {
    const t = await createTenant('plan-guard-risk');
    for (let i = 0; i < 40; i += 1) {
      const id = await createCustomer(
        t.admin,
        t.merchantAccountId,
        t.defaultShop,
        `Risque ${String(i).padStart(3, '0')}`,
      );
      await createOrder(t.admin, t.merchantAccountId, t.defaultShop, id, 'REFUSEE');
    }

    const pg = createTestPostgresClient(dbUrl);
    await pg.connect();
    try {
      await pg.query(`select set_config('request.jwt.claim.sub', $1, false)`, [t.userId]);
      const result = await pg.query(
        `explain (analyze, buffers, costs off)
         select v.customer_id, v.score, v.tier
         from public.customer_reliability_scored v
         where v.merchant_account_id = $1 and v.shop_id = $2
         order by case v.tier when 'risk' then 0 when 'watch' then 1 when 'new' then 2
                              when 'reliable' then 3 else 4 end,
                  v.score asc nulls last, v.full_name asc nulls last, v.customer_id
         limit 10`,
        [t.merchantAccountId, t.defaultShop],
      );
      const plan = result.rows.map((r) => r['QUERY PLAN'] as string).join('\n');

      expect(plan).not.toMatch(/get_store_customer_reliability/);
      expect(plan).toMatch(/customer_reliability_projection/);
    } finally {
      await pg.end();
    }
  });
});
