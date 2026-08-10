// S3-A3 — preuve exécutable, contre une vraie base Postgres locale, que le bridge fonctionne
// à CHAQUE état de schéma entre "avant 0120" et "après 0120-0125". Ce fichier ne suppose rien :
// il vérifie le comportement réel (colonnes présentes/absentes, code d'erreur Postgres exact sur
// la contrainte webhook_event_status_check) contre la base réellement migrée au moment du run.
//
// Ce test tourne à CHAQUE préfixe de schéma (S0..S6) en relançant `supabase db reset --local`
// avec le sous-ensemble de migrations correspondant — jamais contre Supabase production.
import { getCustomerPcdColumnsAvailable } from '@/lib/shopify/customer-pcd-columns';
import { type ShopifyOrderNode, persistShopifyOrder } from '@/lib/shopify/orders-sync';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const skipIfNoServiceRole = serviceRoleKey ? it : it.skip;

type AdminClient = SupabaseClient<Database>;
const createdUserIds: string[] = [];
const createdWebhookEventIds: string[] = [];

function adminClient(): AdminClient {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createUser(admin: AdminClient, email: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: 'bridge-dual-schema-rls-test',
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('User creation failed');
  createdUserIds.push(data.user.id);
  return data.user.id;
}

async function waitForMerchantAccount(admin: AdminClient, userId: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const { data } = await admin
      .from('merchant_account')
      .select('id')
      .eq('owner_user_id', userId)
      .maybeSingle();
    if (data?.id) return data.id;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('merchant_account not found');
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  if (createdWebhookEventIds.length > 0) {
    await admin.from('webhook_event').delete().in('id', createdWebhookEventIds.splice(0));
  }
  await Promise.all(createdUserIds.splice(0).map((id) => admin.auth.admin.deleteUser(id)));
});

function makeOrderNode(suffix: string, withTags: boolean): ShopifyOrderNode {
  return {
    id: `gid://shopify/Order/${suffix}`,
    name: `#bridge-${suffix}`,
    createdAt: '2026-08-01T10:00:00Z',
    displayFinancialStatus: 'PENDING',
    displayFulfillmentStatus: 'UNFULFILLED',
    currentTotalPriceSet: { shopMoney: { amount: '5000', currencyCode: 'XOF' } },
    customer: {
      id: `gid://shopify/Customer/${suffix}`,
      displayName: 'Client Bridge',
      phone: `+22177${suffix.slice(-7)}`,
      numberOfOrders: 3,
      amountSpent: { amount: '15000' },
      tags: withTags ? ['bridge', 'S3-A3'] : null,
      emailMarketingConsent: { marketingState: 'SUBSCRIBED' },
      createdAt: '2026-01-01T00:00:00Z',
    },
    shippingAddress: null,
    lineItems: {
      edges: [
        {
          node: {
            title: 'Produit bridge',
            sku: 'BRIDGE-1',
            quantity: 1,
            originalUnitPriceSet: { shopMoney: { amount: '5000' } },
            variant: null,
            product: null,
          },
        },
      ],
    },
  };
}

describe('Bridge S3-A3 — capability detection (0120) contre la base réelle', () => {
  skipIfNoServiceRole('reflète exactement la présence/absence des colonnes PCD', async () => {
    const admin = adminClient();
    const available = await getCustomerPcdColumnsAvailable(admin);

    // Vérité terrain : un client NEUF (jamais passé par le cache WeakMap) refait la même sonde
    // indépendamment, pour prouver que la détection mise en cache ne se trompe jamais.
    const freshAdmin = adminClient();
    const probe = await freshAdmin.from('customer').select('tags').limit(0);
    const groundTruthAvailable = !probe.error;

    expect(available).toBe(groundTruthAvailable);
  });
});

describe('Bridge S3-A3 — persistShopifyOrder dual-schema (0120) contre la base réelle', () => {
  skipIfNoServiceRole(
    'crée commande + client sans jamais référencer une colonne absente du schéma courant',
    async () => {
      const admin = adminClient();
      const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const ownerEmail = `bridge-owner-${suffix}@example.com`;
      const ownerId = await createUser(admin, ownerEmail);
      const merchantAccountId = await waitForMerchantAccount(admin, ownerId);

      const { data: shop, error: shopError } = await admin
        .from('shop')
        .insert({
          merchant_account_id: merchantAccountId,
          shop_domain: `bridge-${suffix}.myshopify.com`,
          access_token_encrypted: 'encrypted-token-placeholder',
          scopes: 'read_orders,read_customers',
        })
        .select('id')
        .single();
      if (shopError || !shop) throw shopError ?? new Error('shop not created');

      const orderNode = makeOrderNode(suffix, true);
      const result = await persistShopifyOrder({
        merchantAccountId,
        orderNode,
        shopId: shop.id,
        supabaseServiceClient: admin,
      });

      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();

      const { data: order, error: orderError } = await admin
        .from('orders')
        .select('id, customer_id, total_amount')
        .eq('merchant_account_id', merchantAccountId)
        .eq('shopify_order_id', suffix)
        .maybeSingle();
      expect(orderError).toBeNull();
      expect(order).not.toBeNull();
      expect(order?.total_amount).toBe(5000);
      expect(order?.customer_id).not.toBeNull();

      // Rejeu (webhook orders/updated) : même chemin, doit rester idempotent et ne jamais
      // référencer une colonne absente lors de la fusion client (merge patch).
      const second = await persistShopifyOrder({
        merchantAccountId,
        orderNode: makeOrderNode(suffix, true),
        shopId: shop.id,
        supabaseServiceClient: admin,
      });
      expect(second.ok).toBe(true);
    },
  );
});

describe('Bridge S3-A3 — webhook_event status constraint (0121) contre la base réelle', () => {
  skipIfNoServiceRole(
    "l'écriture de status='error' réussit ou échoue en 23514 exactement selon le schéma, jamais autrement",
    async () => {
      const admin = adminClient();
      const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

      const { data: event, error: insertError } = await admin
        .from('webhook_event')
        .insert({
          shopify_webhook_id: `bridge-wh-${suffix}`,
          topic: 'orders/create',
          status: 'processing',
        })
        .select('id')
        .single();
      if (insertError || !event) throw insertError ?? new Error('webhook_event not created');
      createdWebhookEventIds.push(event.id);

      const { error: updateError } = await admin
        .from('webhook_event')
        .update({ status: 'error', processed: false })
        .eq('id', event.id);

      if (updateError) {
        // Doit être EXACTEMENT la violation attendue — jamais une autre erreur.
        expect(updateError.code).toBe('23514');
        expect(updateError.message).toContain('webhook_event_status_check');

        // Le bridge retombe sur 'retryable' — doit réussir sous le nouveau schéma.
        const fallback = await admin
          .from('webhook_event')
          .update({ status: 'retryable', processed: false })
          .eq('id', event.id);
        expect(fallback.error).toBeNull();
      } else {
        // Schéma avant 0121 : 'error' est une valeur légale, rien à faire de plus.
        const { data: row } = await admin
          .from('webhook_event')
          .select('status')
          .eq('id', event.id)
          .single();
        expect(row?.status).toBe('error');
      }
    },
  );
});
