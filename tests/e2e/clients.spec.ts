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
  return `e2e+phase7b-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
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

// Client enrichi (PII 7b) + 2 commandes livrées → order_count=2 (récurrent) avec adresse flexible.
async function seedRecurringEnrichedCustomer(
  admin: AdminClient,
  merchantAccountId: string,
  fullName: string,
) {
  const { data: customer } = await admin
    .from('customer')
    .insert({
      merchant_account_id: merchantAccountId,
      source: 'shopify',
      full_name: fullName,
      first_name: 'Awa',
      last_name: 'Diop',
      phone: '+221771234567',
      phone_e164: '+221771234567',
      address: { raw: 'Cité Keur Gorgui, près de la mosquée', city: 'Dakar', region: 'Dakar' },
      shopify_customer_gids: ['123456'],
    })
    .select('id')
    .single();
  if (!customer) throw new Error('customer insert returned no row');

  for (let i = 0; i < 2; i++) {
    await admin.from('orders').insert({
      merchant_account_id: merchantAccountId,
      customer_id: customer.id,
      source: 'shopify',
      order_number: `7B-${Date.now()}-${i}`,
      total_amount: 20000,
      currency: 'XOF',
      items_summary: [{ title: 'Sac', quantity: 1, price: 20000 }],
      order_state: 'completed',
      call_state: 'validated',
      delivery_state: 'delivered',
      cash_state: 'collected',
    });
  }

  return customer.id;
}

async function createOwnerFixture(label: string) {
  const admin = adminClient();
  const email = e2eEmail(label);
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchant(admin, userId);
  await admin
    .from('merchant_account')
    .update({ name: `Tëër E2E Phase7b ${label}`, onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);
  return { admin, email, merchantAccountId, userId };
}

async function signIn(page: Page, email: string, redirectTo = '/clients') {
  await page.goto(`/connexion?redirectTo=${encodeURIComponent(redirectTo)}`);
  await page.getByLabel(messages.auth.email_label, { exact: true }).fill(email);
  await page.getByLabel(messages.auth.password_label, { exact: true }).fill(password);
  await page.getByRole('button', { name: messages.auth.signin.submit }).click();
  await page.waitForURL(`**${redirectTo}`);
}

test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les E2E clients');

test('fiche client enrichie : badge récurrent + adresse', async ({ page }) => {
  const { email, merchantAccountId } = await createOwnerFixture('recurring');
  const fullName = `Awa Recurrente ${Date.now()}`;
  await seedRecurringEnrichedCustomer(adminClient(), merchantAccountId, fullName);

  await signIn(page, email, '/clients');

  // Recherche puis présence dans la liste.
  await page.getByPlaceholder(messages.clients.search.placeholder).fill(fullName);
  await expect(page.getByText(fullName).first()).toBeVisible();

  // Ouvre la fiche : badge récurrent, adresse flexible, stat commandes Shopify.
  // Le badge « récurrent » est masqué dans la ligne liste sur mobile (@min-[26rem]/row:hidden)
  // mais toujours visible dans la fiche client (CustomerBadges).
  await page.getByText(fullName).first().click();
  // exact:true évite le substring match sur le span masqué de la liste (« · Client récurrent »)
  await expect(page.getByText(messages.clients.badges.recurring, { exact: true })).toBeVisible();
  await expect(page.getByText('Cité Keur Gorgui, près de la mosquée')).toBeVisible();
});
