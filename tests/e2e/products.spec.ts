import { existsSync, readFileSync } from 'node:fs';
import messages from '@/messages/fr.json';
import { type Page, expect, test } from '@playwright/test';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './helpers/assert-local-supabase';
import { grantCurrentConsents } from './helpers/consent';

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
  return `e2e+phase7-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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
  let merchantAccountId = '';
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from('merchant_member')
          .select('merchant_account_id')
          .eq('user_id', userId)
          .limit(1)
          .maybeSingle();
        merchantAccountId = (data?.merchant_account_id as string | undefined) ?? '';
        return merchantAccountId;
      },
      { timeout: 10_000, intervals: [150, 300, 500] },
    )
    .not.toBe('');
  return merchantAccountId;
}

async function createOwnerFixture(label: string) {
  const admin = adminClient();
  const email = e2eEmail(label);
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchant(admin, userId);
  await admin
    .from('merchant_account')
    .update({ name: `Tëër E2E Produits ${label}`, onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);
  return { admin, email, merchantAccountId, userId };
}

async function seedProducts(
  admin: AdminClient,
  merchantAccountId: string,
  count: number,
  prefix = 'Produit',
) {
  const rows = Array.from({ length: count }, (_, i) => ({
    merchant_account_id: merchantAccountId,
    title: `${prefix} ${String(i + 1).padStart(3, '0')}`,
    sku: `SKU-${i + 1}`,
    unit_cost: 1000,
    is_active: true,
  }));
  await admin.from('product').insert(rows);
}

async function signIn(page: Page, email: string, redirectTo = '/produits') {
  await page.goto(`/connexion?redirectTo=${encodeURIComponent(redirectTo)}`);
  await page.getByLabel(messages.auth.email_label).fill(email);
  await page.getByLabel(messages.auth.password_label).fill(password);
  await page.getByRole('button', { name: messages.auth.submit }).click();
  await page.waitForURL(`**${redirectTo}`);
}

test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E produits');

test('page produits : catalogue vide → message vide affiché', async ({ page }) => {
  const fixture = await createOwnerFixture('empty');
  try {
    await signIn(page, fixture.email);
    await expect(page.getByText('Aucun produit dans le catalogue pour le moment.')).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});

test('page produits : 25 produits → pas de bouton Voir plus', async ({ page }) => {
  const fixture = await createOwnerFixture('no-more');
  try {
    await fixture.admin
      .from('merchant_account')
      .update({ onboarded_at: new Date().toISOString() })
      .eq('id', fixture.merchantAccountId);
    await seedProducts(fixture.admin, fixture.merchantAccountId, 25);
    await signIn(page, fixture.email);
    await expect(page.getByRole('heading', { name: 'Produit 001' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('button', { name: 'Voir plus' })).not.toBeVisible();
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});

test('page produits : 26 produits → bouton Voir plus visible', async ({ page }) => {
  const fixture = await createOwnerFixture('voir-plus');
  try {
    await seedProducts(fixture.admin, fixture.merchantAccountId, 26);
    await signIn(page, fixture.email);
    await expect(page.getByRole('button', { name: 'Voir plus' })).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});

test('page produits : recherche filtre par titre côté serveur', async ({ page }) => {
  const fixture = await createOwnerFixture('search');
  try {
    await seedProducts(fixture.admin, fixture.merchantAccountId, 5, 'Alpha');
    await fixture.admin.from('product').insert({
      merchant_account_id: fixture.merchantAccountId,
      title: 'Sac cuir noir',
      sku: 'SAC-001',
      unit_cost: 5000,
      is_active: true,
    });
    await signIn(page, fixture.email);

    // All products visible initially
    await expect(page.getByRole('heading', { name: 'Alpha 001' })).toBeVisible({
      timeout: 15_000,
    });

    // Type in search bar
    await page.getByPlaceholder('Rechercher par titre ou SKU…').fill('sac cuir');
    // Wait for debounce + navigation
    await page.waitForURL('**/produits?q=sac+cuir', { timeout: 10_000 });

    await expect(page.getByRole('heading', { name: 'Sac cuir noir' })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole('heading', { name: 'Alpha 001' })).not.toBeVisible();
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});

test('onglet Achats : visible pour owner, menu tab navigation présent', async ({ page }) => {
  const fixture = await createOwnerFixture('achats-tab');
  try {
    await signIn(page, fixture.email);
    const achatLink = page.getByRole('link', { name: 'Achats fournisseur' });
    await expect(achatLink).toBeVisible({ timeout: 15_000 });
    await achatLink.click();
    await page.waitForURL('**/produits?tab=achats', { timeout: 10_000 });
    // La barre d'onglets reste présente (retour Catalogue possible).
    await expect(page.getByRole('link', { name: 'Catalogue', exact: true })).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    await fixture.admin.auth.admin.deleteUser(fixture.userId);
  }
});
