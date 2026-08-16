import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

// Non-régression des grants de COLONNE sur `shop_id` (migration 0130).
//
// 0126 ajoute `shop_id` aux tables métier, mais plusieurs d'entre elles suivent
// un modèle de grants restrictif (`revoke all from authenticated` puis
// `grant select (col, …)` colonne par colonne, cf. 0027/0028/0107). Une colonne
// ajoutée après coup n'y est donc accessible par AUCUN privilège tant qu'elle
// n'est pas explicitement accordée — et PostgreSQL exige SELECT sur toute
// colonne lue dans un WHERE, INSERT sur toute colonne écrite.
//
// Ces tests exercent le VRAI chemin de production : une session `authenticated`
// (client anon + signInWithPassword), exactement comme `ctx.supabase` dans les
// server actions. Un test en service-role ne prouverait RIEN ici : le
// service-role contourne aussi bien les grants que les policies, donc il
// resterait vert avec les grants manquants.
//
// Les grants sont évalués AVANT les policies : sans 0130 ces assertions
// échouent en « permission denied for table … », pas en violation de policy.

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'workspace-shop-id-grants-pw';
const createdUserIds: string[] = [];

const skipIfNoServiceRole = !serviceRoleKey ? it.skip : it;
type Client = SupabaseClient<Database>;

function adminClient(): Client {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createOwner(admin: Client, label: string) {
  const email = `shop-id-grants-${label}-${Date.now()}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    password,
  });
  if (error || !data.user) throw error ?? new Error('user creation failed');
  createdUserIds.push(data.user.id);

  let merchantAccountId = '';
  for (let attempt = 0; attempt < 40 && !merchantAccountId; attempt += 1) {
    const { data: member } = await admin
      .from('merchant_member')
      .select('merchant_account_id')
      .eq('user_id', data.user.id)
      .limit(1)
      .maybeSingle();
    merchantAccountId = member?.merchant_account_id ?? '';
    if (!merchantAccountId) await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (!merchantAccountId) throw new Error('merchant_member introuvable');

  // handle_new_user (0126) provisionne la boutique manuelle par défaut.
  const { data: shop, error: shopError } = await admin
    .from('shop')
    .select('id')
    .eq('merchant_account_id', merchantAccountId)
    .eq('is_default', true)
    .single();
  if (shopError || !shop) throw shopError ?? new Error('boutique par defaut introuvable');

  return { email, merchantAccountId, shopId: shop.id as string };
}

async function signIn(email: string): Promise<Client> {
  const client = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

async function createProduct(
  admin: Client,
  merchantAccountId: string,
  title: string,
  isBundle = false,
): Promise<string> {
  const { data, error } = await admin
    .from('product')
    .insert({
      is_active: true,
      is_bundle: isBundle,
      merchant_account_id: merchantAccountId,
      title,
      unit_cost: 1000,
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('product insert failed');
  return data.id as string;
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  for (const userId of createdUserIds) {
    await admin.auth.admin.deleteUser(userId);
  }
  createdUserIds.length = 0;
});

describe('0130 — grants de colonne shop_id pour authenticated', () => {
  skipIfNoServiceRole('une session authenticated peut filtrer sur product.shop_id', async () => {
    const admin = adminClient();
    const owner = await createOwner(admin, 'select');
    await createProduct(admin, owner.merchantAccountId, 'Produit Grants RLS');

    const client = await signIn(owner.email);
    const { data, error } = await client
      .from('product')
      .select('id, shop_id')
      .eq('merchant_account_id', owner.merchantAccountId)
      .eq('shop_id', owner.shopId);

    // Sans le grant SELECT (shop_id), l'erreur serait
    // « permission denied for table product » — jamais un simple jeu vide.
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  skipIfNoServiceRole(
    'une session authenticated peut mettre à jour un produit filtré par shop_id',
    async () => {
      const admin = adminClient();
      const owner = await createOwner(admin, 'update');
      const productId = await createProduct(admin, owner.merchantAccountId, 'Produit Grants MAJ');

      const client = await signIn(owner.email);
      const { data, error } = await client
        .from('product')
        .update({ is_bundle: true, updated_at: new Date().toISOString() })
        .eq('id', productId)
        .eq('merchant_account_id', owner.merchantAccountId)
        .eq('shop_id', owner.shopId)
        .select('id');

      expect(error).toBeNull();
      // La ligne doit être réellement touchée : un 0-ligne silencieux
      // signalerait un filtre qui ne matche plus (régression de scoping).
      expect(data).toHaveLength(1);
    },
  );

  skipIfNoServiceRole(
    'une session authenticated peut écrire product_bundle_component avec son shop_id',
    async () => {
      const admin = adminClient();
      const owner = await createOwner(admin, 'insert');
      const bundleId = await createProduct(admin, owner.merchantAccountId, 'Kit Grants', true);
      const componentId = await createProduct(admin, owner.merchantAccountId, 'Composant Grants');

      const client = await signIn(owner.email);

      // Chemin exact de saveBundleConfigurationAction : delete filtré par
      // shop_id (exige SELECT sur la colonne), puis insert la portant.
      const { error: deleteError } = await client
        .from('product_bundle_component')
        .delete()
        .eq('bundle_product_id', bundleId)
        .eq('merchant_account_id', owner.merchantAccountId)
        .eq('shop_id', owner.shopId);
      expect(deleteError).toBeNull();

      const { error: insertError } = await client.from('product_bundle_component').insert({
        bundle_product_id: bundleId,
        component_product_id: componentId,
        merchant_account_id: owner.merchantAccountId,
        quantity: 2,
        shop_id: owner.shopId,
      });
      expect(insertError).toBeNull();

      const { data: persisted } = await admin
        .from('product_bundle_component')
        .select('quantity, shop_id')
        .eq('bundle_product_id', bundleId);
      expect(persisted).toHaveLength(1);
      expect(persisted?.[0]?.shop_id).toBe(owner.shopId);
    },
  );

  skipIfNoServiceRole(
    'shop_id reste NON modifiable : aucune ligne ne peut changer de boutique',
    async () => {
      const admin = adminClient();
      const owner = await createOwner(admin, 'no-move');
      const productId = await createProduct(admin, owner.merchantAccountId, 'Produit Fixe');

      // Seconde boutique du MÊME tenant : le cas que 0130 refuse délibérément
      // de permettre en n'accordant jamais UPDATE (shop_id). Une policy ne
      // suffirait pas ici — déplacer entre deux boutiques légitimes de
      // l'utilisateur passerait tous les `with check`.
      const { data: secondShop, error: shopError } = await admin
        .from('shop')
        .insert({
          access_token_encrypted: 'enc',
          merchant_account_id: owner.merchantAccountId,
          scopes: 'read_orders',
          shop_domain: `grants-second-${Date.now()}.internal`,
        })
        .select('id')
        .single();
      if (shopError || !secondShop) throw shopError ?? new Error('seconde boutique non creee');

      const client = await signIn(owner.email);
      const { error } = await client
        .from('product')
        .update({ shop_id: secondShop.id })
        .eq('id', productId);

      expect(error).not.toBeNull();

      const { data: unchanged } = await admin
        .from('product')
        .select('shop_id')
        .eq('id', productId)
        .single();
      expect(unchanged?.shop_id).toBe(owner.shopId);
    },
  );
});
