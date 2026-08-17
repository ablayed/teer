/**
 * Migration 0133 — appartenance des livreurs aux boutiques.
 *
 * Le smoke authentifié a montré que `/livreurs` affichait le MÊME parc dans les
 * deux boutiques d'un compte multi-boutiques. Cause : `driver` n'a jamais eu de
 * `shop_id`, et sa RLS est purement locataire.
 *
 * Ces tests portent sur la couche SERVEUR (table d'appartenance, RLS, garde
 * d'affectation), jamais sur un filtrage de composant React : un filtre côté
 * rendu masquerait le défaut sans le corriger.
 */

import { randomUUID } from 'node:crypto';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterAll, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'driver-store-scope-rls-pw-0133';
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

async function createSecondaryShop(admin: Client, merchantAccountId: string, userId: string) {
  const { data, error } = await admin
    .from('shop')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_domain: `driver-scope-${Date.now()}-${randomUUID()}.internal`,
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
    user_id: userId,
    role: 'owner',
  });
  if (memberError && !memberError.message.includes('duplicate')) throw memberError;
  return data.id;
}

async function createTenant(label: string) {
  const admin = adminClient();
  const email = `driver-scope-${label}-${Date.now()}-${randomUUID()}@example.com`;
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchantAccount(admin, userId);
  const defaultShop = await defaultShopId(admin, merchantAccountId);
  return { admin, email, userId, merchantAccountId, defaultShop };
}

/** Crée un livreur ET son rattachement à une boutique, comme le fait l'action. */
async function createDriver(
  admin: Client,
  merchantAccountId: string,
  shopId: string | null,
  fullName: string,
) {
  const { data, error } = await admin
    .from('driver')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: fullName,
      phone: `+2217${Math.floor(Math.random() * 90000000 + 10000000)}`,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('driver insert failed');

  if (shopId) {
    const { error: membershipError } = await admin.from('driver_shop').insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      driver_id: data.id,
    });
    if (membershipError) throw membershipError;
  }

  return data.id;
}

async function createOrder(admin: Client, merchantAccountId: string, shopId: string) {
  const { data, error } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shopId,
      order_number: `DRV-${Date.now()}-${randomUUID().slice(0, 8)}`,
      total_amount: 10000,
      currency: 'XOF',
      order_state: 'open',
      call_state: 'validated',
      delivery_state: 'scheduled',
      cash_state: 'not_due',
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('order insert failed');
  return data.id;
}

/** Livreurs visibles pour une boutique — la requête que fait `/livreurs`. */
async function listStoreDrivers(client: Client, merchantAccountId: string, shopId: string) {
  const { data, error } = await client
    .from('driver_shop')
    .select('driver_id')
    .eq('merchant_account_id', merchantAccountId)
    .eq('shop_id', shopId);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => row.driver_id).sort();
}

function eligibilityRpc(client: Client) {
  return client.rpc.bind(client) as unknown as (
    fn: 'is_driver_in_shop',
    args: { p_merchant_account_id: string; p_driver_id: string; p_shop_id: string },
  ) => Promise<{ data: boolean | null; error: { message: string } | null }>;
}

afterAll(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  for (const userId of createdUserIds) {
    await admin.auth.admin.deleteUser(userId);
  }
  createdUserIds.length = 0;
});

describe('0133 — isolation des livreurs par boutique', () => {
  runIf('chaque boutique ne voit que ses propres livreurs', async () => {
    const t = await createTenant('isolation');
    const secondary = await createSecondaryShop(t.admin, t.merchantAccountId, t.userId);

    const defaultDriver = await createDriver(
      t.admin,
      t.merchantAccountId,
      t.defaultShop,
      'Livreur Defaut',
    );
    const secondaryDriver = await createDriver(
      t.admin,
      t.merchantAccountId,
      secondary,
      'Livreur Secondaire',
    );

    const session = await signIn(t.email);

    const inDefault = await listStoreDrivers(session, t.merchantAccountId, t.defaultShop);
    const inSecondary = await listStoreDrivers(session, t.merchantAccountId, secondary);

    expect(inDefault).toEqual([defaultDriver]);
    expect(inSecondary).toEqual([secondaryDriver]);

    // L'assertion qui aurait rougi AVANT 0133 : les deux boutiques renvoyaient
    // exactement le même parc.
    expect(inDefault).not.toEqual(inSecondary);
    expect(inDefault).not.toContain(secondaryDriver);
    expect(inSecondary).not.toContain(defaultDriver);
  });

  runIf('les compteurs par boutique diffèrent réellement', async () => {
    const t = await createTenant('counts');
    const secondary = await createSecondaryShop(t.admin, t.merchantAccountId, t.userId);

    for (let i = 0; i < 3; i += 1) {
      await createDriver(t.admin, t.merchantAccountId, t.defaultShop, `Defaut ${i}`);
    }
    await createDriver(t.admin, t.merchantAccountId, secondary, 'Secondaire unique');

    const session = await signIn(t.email);
    expect((await listStoreDrivers(session, t.merchantAccountId, t.defaultShop)).length).toBe(3);
    expect((await listStoreDrivers(session, t.merchantAccountId, secondary)).length).toBe(1);
  });

  runIf('un livreur peut servir DEUX boutiques — le cas réel de production', async () => {
    const t = await createTenant('shared');
    const secondary = await createSecondaryShop(t.admin, t.merchantAccountId, t.userId);

    const shared = await createDriver(
      t.admin,
      t.merchantAccountId,
      t.defaultShop,
      'Livreur Commun',
    );
    const { error } = await t.admin.from('driver_shop').insert({
      merchant_account_id: t.merchantAccountId,
      shop_id: secondary,
      driver_id: shared,
    });
    expect(error).toBeNull();

    const session = await signIn(t.email);
    expect(await listStoreDrivers(session, t.merchantAccountId, t.defaultShop)).toContain(shared);
    expect(await listStoreDrivers(session, t.merchantAccountId, secondary)).toContain(shared);

    // Et il reste éligible dans les deux.
    const rpc = eligibilityRpc(session);
    expect(
      (
        await rpc('is_driver_in_shop', {
          p_merchant_account_id: t.merchantAccountId,
          p_driver_id: shared,
          p_shop_id: t.defaultShop,
        })
      ).data,
    ).toBe(true);
    expect(
      (
        await rpc('is_driver_in_shop', {
          p_merchant_account_id: t.merchantAccountId,
          p_driver_id: shared,
          p_shop_id: secondary,
        })
      ).data,
    ).toBe(true);
  });

  runIf('mono-boutique : comportement inchangé, le livreur reste visible', async () => {
    const t = await createTenant('mono');
    const driverId = await createDriver(
      t.admin,
      t.merchantAccountId,
      t.defaultShop,
      'Livreur Mono',
    );

    const session = await signIn(t.email);
    expect(await listStoreDrivers(session, t.merchantAccountId, t.defaultShop)).toEqual([driverId]);
  });
});

describe('0133 — éligibilité à l affectation', () => {
  runIf('un livreur d une autre boutique n est pas éligible', async () => {
    const t = await createTenant('assign');
    const secondary = await createSecondaryShop(t.admin, t.merchantAccountId, t.userId);
    const secondaryDriver = await createDriver(
      t.admin,
      t.merchantAccountId,
      secondary,
      'Livreur B',
    );

    const session = await signIn(t.email);
    const rpc = eligibilityRpc(session);

    // Éligible dans sa boutique…
    expect(
      (
        await rpc('is_driver_in_shop', {
          p_merchant_account_id: t.merchantAccountId,
          p_driver_id: secondaryDriver,
          p_shop_id: secondary,
        })
      ).data,
    ).toBe(true);

    // …et refusé pour une commande de la boutique par défaut.
    expect(
      (
        await rpc('is_driver_in_shop', {
          p_merchant_account_id: t.merchantAccountId,
          p_driver_id: secondaryDriver,
          p_shop_id: t.defaultShop,
        })
      ).data,
    ).toBe(false);
  });

  runIf('un identifiant de livreur forgé ou d un autre locataire est refusé', async () => {
    const t = await createTenant('forged');
    const other = await createTenant('forged-other');
    const foreignDriver = await createDriver(
      other.admin,
      other.merchantAccountId,
      other.defaultShop,
      'Livreur Etranger',
    );

    const session = await signIn(t.email);
    const rpc = eligibilityRpc(session);

    // Livreur d'un AUTRE locataire, présenté sur notre boutique.
    expect(
      (
        await rpc('is_driver_in_shop', {
          p_merchant_account_id: t.merchantAccountId,
          p_driver_id: foreignDriver,
          p_shop_id: t.defaultShop,
        })
      ).data,
    ).toBe(false);

    // Sonder l'appartenance CHEZ l'autre locataire : garde de rôle NULL-safe.
    expect(
      (
        await rpc('is_driver_in_shop', {
          p_merchant_account_id: other.merchantAccountId,
          p_driver_id: foreignDriver,
          p_shop_id: other.defaultShop,
        })
      ).data,
    ).toBe(false);

    // UUID purement inventé.
    expect(
      (
        await rpc('is_driver_in_shop', {
          p_merchant_account_id: t.merchantAccountId,
          p_driver_id: randomUUID(),
          p_shop_id: t.defaultShop,
        })
      ).data,
    ).toBe(false);
  });

  runIf('une commande ne peut pas être assignée au livreur d une autre boutique', async () => {
    const t = await createTenant('assign-guard');
    const secondary = await createSecondaryShop(t.admin, t.merchantAccountId, t.userId);
    const secondaryDriver = await createDriver(
      t.admin,
      t.merchantAccountId,
      secondary,
      'Livreur B',
    );
    const defaultDriver = await createDriver(
      t.admin,
      t.merchantAccountId,
      t.defaultShop,
      'Livreur A',
    );
    const orderInDefault = await createOrder(t.admin, t.merchantAccountId, t.defaultShop);

    const session = await signIn(t.email);
    const rpc = eligibilityRpc(session);

    const foreign = await rpc('is_driver_in_shop', {
      p_merchant_account_id: t.merchantAccountId,
      p_driver_id: secondaryDriver,
      p_shop_id: t.defaultShop,
    });
    const own = await rpc('is_driver_in_shop', {
      p_merchant_account_id: t.merchantAccountId,
      p_driver_id: defaultDriver,
      p_shop_id: t.defaultShop,
    });

    expect(foreign.data).toBe(false);
    expect(own.data).toBe(true);

    // La commande existe bien dans la boutique par défaut : c'est sa boutique qui
    // pilote la garde applicative, pas la boutique active de la requête.
    const { data: order } = await t.admin
      .from('orders')
      .select('shop_id')
      .eq('id', orderInDefault)
      .single();
    expect(order?.shop_id).toBe(t.defaultShop);
  });
});

describe('0133 — RLS de la table d appartenance', () => {
  runIf('un autre locataire ne lit rien', async () => {
    const a = await createTenant('rls-a');
    const b = await createTenant('rls-b');
    const driverA = await createDriver(a.admin, a.merchantAccountId, a.defaultShop, 'Livreur A');

    const sessionB = await signIn(b.email);
    const { data } = await sessionB
      .from('driver_shop')
      .select('driver_id')
      .eq('driver_id', driverA);
    expect(data ?? []).toEqual([]);
  });

  runIf('un non-membre de la boutique ne lit pas ses rattachements', async () => {
    const t = await createTenant('rls-non-member');
    const secondary = await createSecondaryShop(t.admin, t.merchantAccountId, t.userId);
    const driverId = await createDriver(t.admin, t.merchantAccountId, secondary, 'Livreur Cache');

    await t.admin.from('shop_member').delete().eq('shop_id', secondary).eq('user_id', t.userId);

    const session = await signIn(t.email);
    const { data } = await session.from('driver_shop').select('driver_id').eq('shop_id', secondary);
    expect(data ?? []).toEqual([]);
    expect((data ?? []).some((row) => row.driver_id === driverId)).toBe(false);
  });

  runIf('un agent ne peut pas rattacher un livreur à une boutique', async () => {
    const t = await createTenant('rls-agent');
    const agentEmail = `driver-scope-agent-${Date.now()}-${randomUUID()}@example.com`;
    const agentUserId = await createConfirmedUser(t.admin, agentEmail);

    await t.admin.from('merchant_member').delete().eq('user_id', agentUserId);
    await t.admin
      .from('merchant_member')
      .insert({ merchant_account_id: t.merchantAccountId, user_id: agentUserId, role: 'agent' });
    await t.admin.from('shop_member').insert({
      merchant_account_id: t.merchantAccountId,
      shop_id: t.defaultShop,
      user_id: agentUserId,
      role: 'agent',
    });

    const driverId = await createDriver(
      t.admin,
      t.merchantAccountId,
      null,
      'Livreur Sans Boutique',
    );

    const agentSession = await signIn(agentEmail);

    // Lecture autorisée (l'affectation est un geste d'agent)…
    const readable = await agentSession
      .from('driver_shop')
      .select('driver_id')
      .eq('shop_id', t.defaultShop);
    expect(readable.error).toBeNull();

    // …mais pas l'écriture : un agent ne décide pas du parc d'une boutique.
    const { error } = await agentSession.from('driver_shop').insert({
      merchant_account_id: t.merchantAccountId,
      shop_id: t.defaultShop,
      driver_id: driverId,
    });
    expect(error).not.toBeNull();
  });

  runIf('un rattachement ne peut pas viser la boutique d un autre locataire', async () => {
    const a = await createTenant('fk-a');
    const b = await createTenant('fk-b');
    const driverA = await createDriver(a.admin, a.merchantAccountId, a.defaultShop, 'Livreur A');

    // Même en service-role, la FK composite (locataire, boutique) interdit de
    // rattacher un livreur à la boutique d'un autre locataire.
    const { error } = await a.admin.from('driver_shop').insert({
      merchant_account_id: a.merchantAccountId,
      shop_id: b.defaultShop,
      driver_id: driverA,
    });
    expect(error).not.toBeNull();
  });
});
