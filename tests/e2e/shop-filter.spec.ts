import { existsSync, readFileSync } from 'node:fs';
import messages from '@/messages/fr.json';
import { type Page, expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './helpers/assert-local-supabase';
import { grantCurrentConsents } from './helpers/consent';

// Phase 13 — le sélecteur boutique filtre Tableau/Finances ; il est masqué en
// mono-boutique ; la création manuelle demande la boutique en multi-boutiques.

function readLocalEnv(): Record<string, string> {
  if (!existsSync('.env.local')) return {};
  return Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const [key, ...valueParts] = line.split('=');
        return [key, valueParts.join('=').replace(/^["']|["']$/g, '')];
      }),
  );
}

const localEnv = readLocalEnv();
const supabaseUrl =
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  localEnv.SUPABASE_URL ??
  localEnv.NEXT_PUBLIC_SUPABASE_URL ??
  '';
const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? localEnv.SUPABASE_SERVICE_ROLE_KEY ?? '';
const hasSupabaseAdmin = Boolean(supabaseUrl && serviceRoleKey);
const password = 'Mot-de-passe-e2e-2026!';

test.setTimeout(90_000);

type AdminClient = SupabaseClient;

function adminClient(): AdminClient {
  assertLocalSupabase(supabaseUrl);
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function e2eEmail(label: string): string {
  return `e2e+phase13-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function createConfirmedUser(admin: AdminClient, email: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('Utilisateur E2E non créé');
  await grantCurrentConsents(admin, data.user.id);
  return data.user.id;
}

async function waitForMerchant(admin: AdminClient, userId: string) {
  for (let i = 0; i < 20; i++) {
    const { data } = await admin
      .from('merchant_member')
      .select('merchant_account_id')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();
    if (data?.merchant_account_id) return data.merchant_account_id as string;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('merchant_account introuvable');
}

async function createOwnerFixture(label: string) {
  const admin = adminClient();
  const email = e2eEmail(label);
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchant(admin, userId);
  await admin
    .from('merchant_account')
    .update({ name: `Tëër E2E Phase13 ${label}`, onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);
  return { admin, email, merchantAccountId, userId };
}

async function createShop(admin: AdminClient, merchantAccountId: string, domain: string) {
  const { data, error } = await admin
    .from('shop')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_domain: domain,
      access_token_encrypted: 'enc',
      scopes: 'read_orders',
    })
    .select('id')
    .single();
  if (error || !data) throw error ?? new Error('shop insert failed');
  return data.id as string;
}

async function seedAppelerOrder(admin: AdminClient, merchantAccountId: string, shopId: string) {
  const { error } = await admin.from('orders').insert({
    merchant_account_id: merchantAccountId,
    shop_id: shopId,
    source: 'manual',
    order_number: `SF-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    total_amount: 12000,
    currency: 'XOF',
    order_state: 'open',
    call_state: 'to_call',
    delivery_state: 'unassigned',
    cash_state: 'not_due',
  });
  if (error) throw error;
}

async function createProduct(admin: AdminClient, merchantAccountId: string) {
  const { data } = await admin
    .from('product')
    .insert({ merchant_account_id: merchantAccountId, title: 'Produit P13', unit_cost: 1000 })
    .select('id')
    .single();
  if (!data) throw new Error('product insert returned no row');
  return data.id as string;
}

async function signIn(page: Page, email: string, redirectTo: string) {
  await page.goto(`/connexion?redirectTo=${encodeURIComponent(redirectTo)}`);
  await page.getByLabel(messages.auth.email_label).fill(email);
  await page.getByLabel(messages.auth.password_label).fill(password);
  await page.getByRole('button', { name: messages.auth.submit }).click();
  await page.waitForURL(`**${redirectTo.split('?')[0]}**`);
}

test.describe('Phase 13 — filtre boutique', () => {
  test.skip(!hasSupabaseAdmin, 'SUPABASE service role requis pour seeder les fixtures');

  test('multi-boutiques : sélecteur visible et filtrant sur le Tableau', async ({ page }) => {
    const { admin, email, merchantAccountId } = await createOwnerFixture('multi');
    const domainA = `a-${Date.now()}.myshopify.com`;
    const domainB = `b-${Date.now()}.myshopify.com`;
    const shopA = await createShop(admin, merchantAccountId, domainA);
    const shopB = await createShop(admin, merchantAccountId, domainB);
    await seedAppelerOrder(admin, merchantAccountId, shopA);
    await seedAppelerOrder(admin, merchantAccountId, shopA);
    await seedAppelerOrder(admin, merchantAccountId, shopB);

    await signIn(page, email, '/tableau');

    // Le sélecteur boutique est présent avec « Toutes » + les deux boutiques.
    const selector = page.getByRole('navigation', { name: messages.tableau.shops.ariaLabel });
    await expect(selector).toBeVisible();
    await expect(selector.getByRole('link', { name: messages.tableau.shops.all })).toBeVisible();
    await expect(selector.getByRole('link', { name: domainA })).toBeVisible();

    // Filtrer sur la boutique A → l'URL porte ?shop=<id>.
    await selector.getByRole('link', { name: domainA }).click();
    await page.waitForURL(`**/tableau?**shop=${shopA}**`);
    expect(page.url()).toContain(`shop=${shopA}`);
  });

  test('mono-boutique : aucun sélecteur boutique', async ({ page }) => {
    const { admin, email, merchantAccountId } = await createOwnerFixture('mono');
    const shop = await createShop(admin, merchantAccountId, `solo-${Date.now()}.myshopify.com`);
    await seedAppelerOrder(admin, merchantAccountId, shop);

    await signIn(page, email, '/tableau');

    await expect(
      page.getByRole('navigation', { name: messages.tableau.shops.ariaLabel }),
    ).toHaveCount(0);
  });

  test('création manuelle : la boutique est demandée en multi-boutiques', async ({ page }) => {
    const { admin, email, merchantAccountId } = await createOwnerFixture('create');
    await createShop(admin, merchantAccountId, `c1-${Date.now()}.myshopify.com`);
    await createShop(admin, merchantAccountId, `c2-${Date.now()}.myshopify.com`);
    await createProduct(admin, merchantAccountId);

    await signIn(page, email, '/commandes');

    await page.getByRole('button', { name: 'Nouvelle commande' }).first().click();
    // Le formulaire ouvert expose un sélecteur de boutique obligatoire (le
    // <label> « Boutique » nomme le combobox).
    const shopSelect = page.getByRole('combobox', { name: 'Boutique' });
    await expect(shopSelect).toBeVisible();
    await expect(shopSelect.locator('option')).toContainText(['Sélectionner une boutique']);
  });
});
