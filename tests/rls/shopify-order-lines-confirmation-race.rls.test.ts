import { randomUUID } from 'node:crypto';
import type { ShopifyOrderNode } from '@/lib/shopify/orders-sync';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

// 0165 — course de confirmation pendant l'import.
//
// L'import lit une commande non confirmée et sans lignes ; un utilisateur la confirme ; l'import
// écrit. La décision prise à la lecture ne vaut plus : elle est revérifiée EN BASE, sous le
// verrou de la commande, sur les deux chemins de reconstruction.
//
// Le test est déterministe : le client remis à l'import suspend chaque appel de reconstruction
// (après la lecture de la commande, avant l'écriture) le temps de confirmer la commande par la
// vraie transition (`transition_order`, sous la session du propriétaire).
//
// Mutations attendues :
//   * retirer la revérification de resync_shopify_order_cart → « charge plus récente » rougit ;
//   * retirer la garde d'état de repair_shopify_order_lines  → « charge identique » rougit.

const captureMessage = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: (...args: unknown[]) => captureMessage(...args),
}));

const { persistShopifyOrder } = await import('@/lib/shopify/orders-sync');
const { persistBulkOrderNodes } = await import('@/lib/shopify/reconcile');

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'confirmation-race-pw';
const createdUserIds: string[] = [];
const run = serviceRoleKey ? it : it.skip;

type AdminClient = SupabaseClient<Database>;
type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>;

function adminClient(): AdminClient {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function fixture() {
  const admin = adminClient();
  const email = `confirmation-race-${Date.now()}-${randomUUID()}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    password,
  });
  if (error || !data.user) throw error ?? new Error('user');
  const userId = data.user.id;
  createdUserIds.push(userId);
  let merchantAccountId = '';
  for (let i = 0; i < 30 && !merchantAccountId; i++) {
    const account = await admin
      .from('merchant_account')
      .select('id')
      .eq('owner_user_id', userId)
      .maybeSingle();
    merchantAccountId = account.data?.id ?? '';
    if (!merchantAccountId) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const shop = await admin
    .from('shop')
    .insert({
      access_token_encrypted: 'dummy',
      merchant_account_id: merchantAccountId,
      scopes: 'read_orders',
      shop_domain: `confirmation-race-${Date.now()}-${randomUUID()}.myshopify.com`,
      status: 'active',
    })
    .select('*')
    .single();
  if (shop.error || !shop.data) throw shop.error ?? new Error('shop');
  const variantId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const product = await admin
    .from('product')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_id: shop.data.id,
      shopify_variant_id: variantId,
      title: 'Produit rapproché',
      unit_cost: 100,
    })
    .select('id')
    .single();
  if (product.error || !product.data) throw product.error ?? new Error('product');
  const stocked = await admin.from('product_stock').upsert({
    merchant_account_id: merchantAccountId,
    product_id: product.data.id,
    qty_on_hand: 50,
    qty_reserved: 0,
    shop_id: shop.data.id,
  });
  if (stocked.error) throw stocked.error;

  const owner = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const signedIn = await owner.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw signedIn.error;

  return {
    admin,
    merchantAccountId,
    owner,
    productId: product.data.id,
    shop: shop.data,
    userId,
    variantId,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function orderNode(f: Fixture, shopifyOrderId: string, updatedAt: string): ShopifyOrderNode {
  return {
    cancelledAt: null,
    createdAt: '2026-08-01T00:00:00Z',
    currentTotalPriceSet: { shopMoney: { amount: '10000', currencyCode: 'XOF' } },
    customAttributes: null,
    customer: null,
    displayFinancialStatus: 'PENDING',
    displayFulfillmentStatus: 'UNFULFILLED',
    id: `gid://shopify/Order/${shopifyOrderId}`,
    lineItems: {
      edges: [
        {
          node: {
            customAttributes: null,
            originalUnitPriceSet: { shopMoney: { amount: '5000' } },
            product: null,
            quantity: 2,
            sku: null,
            title: 'Produit rapproché',
            variant: { id: `gid://shopify/ProductVariant/${f.variantId}` },
          },
        },
      ],
    },
    name: `#${shopifyOrderId}`,
    note: null,
    shippingAddress: null,
    updatedAt,
  } as ShopifyOrderNode;
}

/** Commande Shopify présente, non confirmée, sans aucune ligne : l'état laissé par l'ancien import. */
async function orderWithoutLines(f: Fixture, shopifyOrderId: string) {
  const created = await persistShopifyOrder({
    merchantAccountId: f.merchantAccountId,
    orderNode: orderNode(f, shopifyOrderId, '2026-08-01T00:00:00Z'),
    shopId: f.shop.id,
    supabaseServiceClient: f.admin,
  });
  expect(created).toEqual({ ok: true });
  const order = await f.admin
    .from('orders')
    .select('id')
    .eq('shop_id', f.shop.id)
    .eq('shopify_order_id', shopifyOrderId)
    .single();
  if (!order.data) throw order.error;
  const dropped = await f.admin.from('order_line').delete().eq('order_id', order.data.id);
  if (dropped.error) throw dropped.error;
  return order.data.id;
}

/**
 * Client d'import qui suspend chaque appel de reconstruction — donc APRÈS la lecture de la
 * commande — le temps de la confirmer par la vraie transition.
 */
function importClientConfirmingBeforeWrite(f: Fixture, orderId: string) {
  const suspended: string[] = [];
  const client = new Proxy(f.admin, {
    get(target, property, receiver) {
      if (property !== 'rpc') return Reflect.get(target, property, receiver);
      return (fn: string, args: Record<string, unknown>) => ({
        // biome-ignore lint/suspicious/noThenProperty: imite le constructeur de requête, qui s'attend.
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          (async () => {
            if (fn === 'repair_shopify_order_lines' || fn === 'resync_shopify_order_cart') {
              suspended.push(fn);
              const confirmed = await (f.owner.rpc.bind(f.owner) as unknown as Rpc)(
                'transition_order',
                {
                  p_actor: f.userId,
                  p_attempt_count: 1,
                  p_call_state: 'validated',
                  p_order_id: orderId,
                },
              );
              expect(confirmed.error).toBeNull();
              expect(confirmed.data).toBe('CONFIRMEE');
            }
            return (target.rpc.bind(target) as unknown as Rpc)(fn, args);
          })().then(resolve, reject),
      });
    },
  }) as AdminClient;
  return { client, suspended };
}

async function observe(f: Fixture, orderId: string) {
  const [lines, movements, stock, order, cursor] = await Promise.all([
    f.admin.from('order_line').select('id').eq('order_id', orderId),
    f.admin.from('stock_movement').select('id').eq('order_id', orderId),
    f.admin.from('product_stock').select('qty_on_hand, qty_reserved').eq('product_id', f.productId),
    f.admin.from('orders').select('call_state, total_amount').eq('id', orderId).single(),
    f.admin.from('shop').select('last_reconciled_at').eq('id', f.shop.id).single(),
  ]);
  return {
    callState: order.data?.call_state,
    cursor: cursor.data?.last_reconciled_at ?? null,
    lines: lines.data?.length,
    movements: movements.data?.length,
    stock: stock.data,
  };
}

afterEach(async () => {
  captureMessage.mockClear();
  if (!serviceRoleKey) return;
  const admin = adminClient();
  await Promise.all(createdUserIds.splice(0).map((id) => admin.auth.admin.deleteUser(id)));
});

describe('0165 — confirmation pendant l import : la décision est revérifiée sous verrou', () => {
  const cases = [
    ['charge plus récente', '2026-08-05T00:00:00Z', 'resync_shopify_order_cart'],
    ['charge identique', '2026-08-01T00:00:00Z', 'repair_shopify_order_lines'],
  ] as const;

  run.each(cases)(
    '%s : confirmée entre la lecture et l écriture → aucune ligne, stock inchangé, aucun mouvement, curseur non bloqué, signalement émis',
    async (_label, updatedAt, expectedCall) => {
      const f = await fixture();
      const shopifyOrderId = `${Date.now()}`;
      const orderId = await orderWithoutLines(f, shopifyOrderId);
      const before = await observe(f, orderId);
      expect(before).toMatchObject({ callState: 'to_call', lines: 0, movements: 0 });
      expect(before.stock).toEqual([{ qty_on_hand: 50, qty_reserved: 0 }]);

      const { client, suspended } = importClientConfirmingBeforeWrite(f, orderId);
      const runStartedAt = '2026-08-27T02:00:00.000Z';
      const outcome = await persistBulkOrderNodes(
        client,
        f.shop,
        [orderNode(f, shopifyOrderId, updatedAt)],
        runStartedAt,
      );

      // L'import a bien été suspendu sur le chemin attendu, et la confirmation a eu lieu.
      expect(suspended).toEqual([expectedCall]);
      const after = await observe(f, orderId);
      expect(after.callState).toBe('validated');
      // Aucune ligne, aucune réserve, aucun mouvement.
      expect(after.lines).toBe(0);
      expect(after.movements).toBe(0);
      expect(after.stock).toEqual([{ qty_on_hand: 50, qty_reserved: 0 }]);
      // Le curseur n'est pas bloqué : ce n'est pas un échec d'import.
      expect(outcome).toMatchObject({ cursorAfter: runStartedAt, failedCount: 0, syncedCount: 1 });
      expect(Date.parse(after.cursor ?? '')).toBe(Date.parse(runStartedAt));
      // Signalement émis, identifiants techniques seuls.
      expect(captureMessage).toHaveBeenCalledTimes(1);
      expect(captureMessage.mock.calls[0]?.[0]).toBe(
        'Shopify reconcile: order has no lines and is not repairable',
      );
    },
  );

  run(
    'contrôle positif : sans confirmation concurrente, la même charge plus récente reconstruit les lignes',
    async () => {
      const f = await fixture();
      const shopifyOrderId = `${Date.now()}`;
      const orderId = await orderWithoutLines(f, shopifyOrderId);

      const result = await persistShopifyOrder({
        merchantAccountId: f.merchantAccountId,
        orderNode: orderNode(f, shopifyOrderId, '2026-08-05T00:00:00Z'),
        shopId: f.shop.id,
        supabaseServiceClient: f.admin,
      });

      expect(result).toEqual({ lines: 'repaired', ok: true });
      expect((await observe(f, orderId)).lines).toBe(1);
      expect(captureMessage).not.toHaveBeenCalled();
    },
  );
});
