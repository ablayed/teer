import { expect, test } from '@playwright/test';
import {
  adminClient,
  cleanupUsers,
  createConfirmedUser,
  e2eEmail,
  e2ePassword,
  hasSupabaseAdmin,
  loginViaForm,
  waitForMerchant,
} from './helpers/auth';

// Affichage de la section "Détails supplémentaires" (note/customAttributes Shopify) sur le
// panneau de détail de commande — affichage brut uniquement, rendu conditionnel (présent vs
// absent), cf. Phase B lot attributs personnalisés Shopify.

test.setTimeout(60_000);
test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour cet E2E');

// Sans onboarded_at, un nouvel utilisateur est redirigé vers /onboarding avant toute page
// applicative — hors scope de ce test, cf. pattern createOwnerFixture (orders-transitions.spec.ts).
async function markOnboarded(admin: ReturnType<typeof adminClient>, merchantAccountId: string) {
  const { error } = await admin
    .from('merchant_account')
    .update({ onboarded_at: new Date().toISOString() })
    .eq('id', merchantAccountId);
  if (error) throw error;
}

async function seedOrder(
  admin: ReturnType<typeof adminClient>,
  merchantAccountId: string,
  overrides: {
    customerName: string;
    shopifyLineItemAttributes?: unknown;
    shopifyOrderAttributes?: unknown;
  },
) {
  const { data: customer, error: customerError } = await admin
    .from('customer')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: overrides.customerName,
      phone: '+221771234567',
    })
    .select('id')
    .single();
  if (customerError) throw customerError;

  const { data: order, error: orderError } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      customer_id: customer.id,
      order_number: `E2E-ATTRS-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      total_amount: 15000,
      currency: 'XOF',
      cod_status: 'A_APPELER',
      order_state: 'open',
      call_state: 'to_call',
      delivery_state: 'unassigned',
      cash_state: 'not_due',
      items_summary: [{ title: 'Sac', sku: 'SAC-1', quantity: 1, price: 15000 }],
      shopify_order_attributes: overrides.shopifyOrderAttributes ?? null,
      shopify_line_item_attributes: overrides.shopifyLineItemAttributes ?? null,
    })
    .select('id')
    .single();
  if (orderError) throw orderError;

  return order.id as string;
}

test('commande avec attributs personnalises Shopify → section "Détails supplémentaires" visible', async ({
  page,
}) => {
  const admin = adminClient();
  const email = e2eEmail('shopify-attrs-present');
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchant(admin, userId);
  await markOnboarded(admin, merchantAccountId);

  try {
    const orderId = await seedOrder(admin, merchantAccountId, {
      customerName: 'Client Attributs Shopify',
      shopifyOrderAttributes: {
        note: 'Livrer avant midi svp',
        attributes: [{ key: 'disponibilite_livraison', value: 'Apres 18h' }],
      },
      shopifyLineItemAttributes: [
        { title: 'Sac', attributes: [{ key: 'couleur', value: 'Rouge' }] },
      ],
    });

    await loginViaForm(page, email, e2ePassword, `/commandes/${orderId}`);
    await page.waitForURL(`**/commandes/${orderId}`);

    const section = page.getByTestId('order-additional-details');
    await expect(section).toBeVisible({ timeout: 15_000 });
    await expect(section).toContainText('Livrer avant midi svp');
    await expect(section).toContainText('disponibilite_livraison');
    await expect(section).toContainText('Apres 18h');
    await expect(section).toContainText('couleur');
    await expect(section).toContainText('Rouge');
  } finally {
    await cleanupUsers(admin, [userId]);
  }
});

test('commande sans attributs personnalises Shopify → section "Détails supplémentaires" absente', async ({
  page,
}) => {
  const admin = adminClient();
  const email = e2eEmail('shopify-attrs-absent');
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchant(admin, userId);
  await markOnboarded(admin, merchantAccountId);

  try {
    const orderId = await seedOrder(admin, merchantAccountId, {
      customerName: 'Client Sans Attributs',
    });

    await loginViaForm(page, email, e2ePassword, `/commandes/${orderId}`);
    await page.waitForURL(`**/commandes/${orderId}`);

    await expect(page.getByRole('heading', { name: 'Client Sans Attributs' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('order-additional-details')).toHaveCount(0);
  } finally {
    await cleanupUsers(admin, [userId]);
  }
});
