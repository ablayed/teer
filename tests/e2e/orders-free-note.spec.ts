import { expect, test } from '@playwright/test';
import {
  adminClient,
  cleanupUsers,
  createConfirmedUser,
  e2eEmail,
  e2ePassword,
  hasSupabaseAdmin,
  landOnTarget,
  loginViaForm,
  waitForMerchant,
} from './helpers/auth';

// 0118 — note libre d'equipe sur le detail de commande.
// Le champ doit etre visible et editable QUEL QUE SOIT l'etat de la commande :
// on couvre donc les deux extremites du cycle de vie, avant assignation
// (A_APPELER) et apres livraison (LIVREE).

test.setTimeout(60_000);
test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour cet E2E');

// `fill()` sur un textarea React CONTROLE deja rempli concatene au lieu de
// remplacer (observe ici : la 2e saisie donnait "nouveau texte" + "ancien
// texte"). Meme classe que la dette E2E (c) du projet sur les inputs numeriques
// controles : on selectionne explicitement le contenu puis on saisit au clavier.
async function setNoteValue(field: import('@playwright/test').Locator, value: string) {
  await field.click();
  await field.press('ControlOrMeta+a');
  await field.press('Backspace');
  await field.pressSequentially(value);
  await expect(field).toHaveValue(value);
}

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
  dimensions: {
    call_state: string;
    cash_state: string;
    delivery_state: string;
    order_state: string;
  },
) {
  const { data: customer, error: customerError } = await admin
    .from('customer')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: 'Client Note Libre',
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
      order_number: `E2E-NOTE-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      total_amount: 15000,
      currency: 'XOF',
      items_summary: [{ title: 'Sac', sku: 'SAC-1', quantity: 1, price: 15000 }],
      ...dimensions,
    })
    .select('id, cod_status')
    .single();
  if (orderError) throw orderError;
  return order;
}

const scenarios = [
  {
    label: 'avant assignation',
    expectedStatus: 'A_APPELER',
    dimensions: {
      order_state: 'open',
      call_state: 'to_call',
      delivery_state: 'unassigned',
      cash_state: 'not_due',
    },
    note: 'Client injoignable le matin, rappeler apres 18h.',
  },
  {
    label: 'apres livraison',
    expectedStatus: 'LIVREE',
    dimensions: {
      order_state: 'completed',
      call_state: 'validated',
      delivery_state: 'delivered',
      cash_state: 'collected',
    },
    note: 'Colis remis au gardien, recu signe conserve.',
  },
] as const;

for (const scenario of scenarios) {
  test(`note libre sur /commandes : saisie et persistance apres rechargement (${scenario.label})`, async ({
    page,
  }) => {
    const admin = adminClient();
    const email = e2eEmail(`free-note-${scenario.expectedStatus.toLowerCase()}`);
    const userId = await createConfirmedUser(admin, email);
    const merchantAccountId = await waitForMerchant(admin, userId);
    await markOnboarded(admin, merchantAccountId);

    try {
      const order = await seedOrder(admin, merchantAccountId, scenario.dimensions);
      expect(order.cod_status).toBe(scenario.expectedStatus);

      await loginViaForm(page, email, e2ePassword, `/commandes/${order.id}`);
      await landOnTarget(page, `/commandes/${order.id}`);

      const section = page.getByTestId('order-note');
      await expect(section).toBeVisible({ timeout: 15_000 });

      const field = section.getByRole('textbox', { name: 'Note libre sur la commande' });
      await expect(field).toHaveValue('');

      await setNoteValue(field, scenario.note);
      await section.getByRole('button', { name: 'Enregistrer la note' }).click();
      await expect(section.getByText('Note enregistrée.')).toBeVisible({ timeout: 15_000 });

      // Persistance reelle : la valeur doit venir de la base, pas d'un etat
      // client survivant. Un rechargement complet le prouve.
      await page.reload();
      await expect(section).toBeVisible({ timeout: 15_000 });
      await expect(field).toHaveValue(scenario.note, { timeout: 15_000 });

      const { data: stored } = await admin
        .from('orders')
        .select('note, cod_status')
        .eq('id', order.id)
        .single();
      expect(stored?.note).toBe(scenario.note);
      // Annoter ne change pas l'etat de la commande.
      expect(stored?.cod_status).toBe(scenario.expectedStatus);

      // La note est modifiable une seconde fois, sans quitter la page.
      await setNoteValue(field, 'Note corrigee apres verification.');
      await section.getByRole('button', { name: 'Enregistrer la note' }).click();
      await expect(section.getByText('Note enregistrée.')).toBeVisible({ timeout: 15_000 });
      await page.reload();
      await expect(field).toHaveValue('Note corrigee apres verification.', { timeout: 15_000 });
    } finally {
      await cleanupUsers(admin, [userId]);
    }
  });
}
