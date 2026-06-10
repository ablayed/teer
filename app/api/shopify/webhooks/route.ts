import { getRegisteredShopifyApps, getShopifyAppForShop } from '@/lib/shopify/apps';
import { compileCustomerData, redactCustomer, redactShop } from '@/lib/shopify/gdpr';
import {
  type ShopifyAddress,
  type ShopifyCustomerNode,
  type ShopifyOrderNode,
  persistShopifyOrder,
} from '@/lib/shopify/orders-sync';
import { type ShopifyProductNode, persistShopifyProductWebhook } from '@/lib/shopify/products-sync';
import { processFinishedBulkForShop } from '@/lib/shopify/reconcile';
import { deriveRefundWebhook } from '@/lib/shopify/refunds';
import { verifyWebhookHmacAnySecret } from '@/lib/shopify/webhook-verify';
import type { Database, Json } from '@/lib/supabase/database.types';
import { createClient } from '@supabase/supabase-js';
import { after } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SupabaseAdminClient = ReturnType<typeof createSupabaseAdminClient>;

function createSupabaseAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return null;
  }

  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function ok() {
  return new Response(null, { status: 200 });
}

function logWebhookInfo(message: string, ...details: unknown[]) {
  // biome-ignore lint/suspicious/noConsole: 5A webhook foundation intentionally logs received topics and dedup decisions.
  console.log(message, ...details);
}

function logWebhookError(message: string, ...details: unknown[]) {
  // biome-ignore lint/suspicious/noConsole: 5A webhook foundation intentionally logs invalid signatures and storage failures.
  console.error(message, ...details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function nestedRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function nullableStringField(record: Record<string, unknown> | null, key: string): string | null {
  return record ? stringField(record, key) : null;
}

function buildCustomerName(customer: Record<string, unknown>, fallbackName: string | null) {
  const firstName = stringField(customer, 'first_name');
  const lastName = stringField(customer, 'last_name');
  const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();

  return fullName || stringField(customer, 'name') || fallbackName;
}

function mapWebhookAddress(rec: Record<string, unknown> | null): ShopifyAddress | null {
  if (!rec) {
    return null;
  }
  return {
    address1: stringField(rec, 'address1'),
    address2: stringField(rec, 'address2'),
    city: stringField(rec, 'city'),
    province: stringField(rec, 'province'),
    country: stringField(rec, 'country'),
    zip: stringField(rec, 'zip'),
    phone: stringField(rec, 'phone'),
    name: stringField(rec, 'name'),
  };
}

// Consentement marketing REST : objet email_marketing_consent { state } (récent) ou champ legacy
// accepts_marketing (bool). On normalise vers la forme GraphQL { marketingState } ; mapShopifyCustomer
// dérive le booléen (SUBSCRIBED).
function deriveWebhookConsent(
  customer: Record<string, unknown>,
): { marketingState: string | null } | null {
  const consent = nestedRecord(customer, 'email_marketing_consent');
  if (consent) {
    return { marketingState: stringField(consent, 'state') };
  }
  const accepts = customer.accepts_marketing;
  if (typeof accepts === 'boolean') {
    return { marketingState: accepts ? 'SUBSCRIBED' : 'NOT_SUBSCRIBED' };
  }
  return null;
}

// Enrichissement client (Phase 7b) depuis le bloc customer d'un webhook commande REST.
function mapWebhookCustomer(
  customer: Record<string, unknown>,
  customerId: string,
  shippingAddress: Record<string, unknown> | null,
  shippingName: string | null,
): ShopifyCustomerNode {
  const tagsRaw = customer.tags;
  const tags =
    typeof tagsRaw === 'string'
      ? tagsRaw
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean)
      : null;
  const ordersCount = customer.orders_count;
  const totalSpent = stringField(customer, 'total_spent');

  return {
    id: customerId,
    displayName: buildCustomerName(customer, shippingName),
    firstName: stringField(customer, 'first_name'),
    lastName: stringField(customer, 'last_name'),
    phone: stringField(customer, 'phone') ?? nullableStringField(shippingAddress, 'phone'),
    email: stringField(customer, 'email'),
    numberOfOrders: typeof ordersCount === 'number' ? ordersCount : null,
    amountSpent: totalSpent ? { amount: totalSpent } : null,
    tags: tags && tags.length > 0 ? tags : null,
    emailMarketingConsent: deriveWebhookConsent(customer),
    createdAt: stringField(customer, 'created_at'),
    defaultAddress: mapWebhookAddress(nestedRecord(customer, 'default_address')),
  };
}

function mapOrderWebhookToOrderNode(payload: unknown): ShopifyOrderNode | null {
  if (!isRecord(payload)) {
    return null;
  }

  const orderId = stringField(payload, 'id');

  if (!orderId) {
    return null;
  }

  const shippingAddress = nestedRecord(payload, 'shipping_address');
  const shippingName = nullableStringField(shippingAddress, 'name');
  const customer = nestedRecord(payload, 'customer');
  const customerId = customer ? stringField(customer, 'id') : null;
  const lineItems = Array.isArray(payload.line_items) ? payload.line_items : [];

  return {
    id: orderId,
    name: stringField(payload, 'name') ?? orderId,
    createdAt: stringField(payload, 'created_at'),
    updatedAt: stringField(payload, 'updated_at'),
    cancelledAt: stringField(payload, 'cancelled_at'),
    displayFinancialStatus: stringField(payload, 'financial_status'),
    displayFulfillmentStatus: stringField(payload, 'fulfillment_status'),
    currentTotalPriceSet: {
      shopMoney: {
        amount: stringField(payload, 'total_price') ?? '0',
        currencyCode: stringField(payload, 'currency') ?? undefined,
      },
    },
    customer:
      customer && customerId
        ? mapWebhookCustomer(customer, customerId, shippingAddress, shippingName)
        : null,
    shippingAddress: shippingAddress
      ? {
          address1: stringField(shippingAddress, 'address1'),
          address2: stringField(shippingAddress, 'address2'),
          city: stringField(shippingAddress, 'city'),
          province: stringField(shippingAddress, 'province'),
          country: stringField(shippingAddress, 'country'),
          zip: stringField(shippingAddress, 'zip'),
          phone: stringField(shippingAddress, 'phone'),
          name: shippingName,
        }
      : null,
    lineItems: {
      edges: lineItems.filter(isRecord).map((lineItem) => ({
        node: {
          title: stringField(lineItem, 'title') ?? '',
          sku: stringField(lineItem, 'sku'),
          quantity: numberField(lineItem, 'quantity'),
          originalUnitPriceSet: {
            shopMoney: {
              amount: stringField(lineItem, 'price') ?? '0',
            },
          },
          variant: (() => {
            const variantId = stringField(lineItem, 'variant_id');

            return variantId ? { id: variantId } : null;
          })(),
          product: (() => {
            const productId = stringField(lineItem, 'product_id');

            return productId ? { id: productId } : null;
          })(),
        },
      })),
    },
  };
}

function mapProductWebhookToProductNode(payload: unknown): ShopifyProductNode | null {
  if (!isRecord(payload)) {
    return null;
  }

  const productId = stringField(payload, 'id');
  const title = stringField(payload, 'title');
  const variants = Array.isArray(payload.variants) ? payload.variants : [];

  if (!productId || !title) {
    return null;
  }

  return {
    id: productId,
    title,
    status: stringField(payload, 'status'),
    variants: {
      edges: variants.filter(isRecord).map((variant) => ({
        node: {
          id: stringField(variant, 'id') ?? '',
          title: stringField(variant, 'title'),
          sku: stringField(variant, 'sku'),
        },
      })),
    },
  };
}

function resolveShopDomain(headerShopDomain: string | null, payload: unknown): string | null {
  if (headerShopDomain) {
    return headerShopDomain;
  }

  if (!isRecord(payload)) {
    return null;
  }

  return stringField(payload, 'shop_domain') ?? stringField(payload, 'myshopify_domain');
}

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

async function getActiveShopByDomain({
  shopDomain,
  supabase,
}: {
  shopDomain: string;
  supabase: NonNullable<SupabaseAdminClient>;
}) {
  const { data, error } = await supabase
    .from('shop')
    .select('id, merchant_account_id, shop_domain')
    .eq('shop_domain', shopDomain)
    .eq('status', 'active')
    .maybeSingle();

  if (error) {
    logWebhookError('[webhook] shop lookup failed', {
      code: error.code,
      details: error.details,
      hint: error.hint,
      message: error.message,
      shopDomain,
    });
    return null;
  }

  return data;
}

async function getShopByDomain({
  shopDomain,
  supabase,
}: {
  shopDomain: string;
  supabase: NonNullable<SupabaseAdminClient>;
}) {
  const { data, error } = await supabase
    .from('shop')
    .select('id, merchant_account_id, shop_domain, status, shopify_client_id')
    .eq('shop_domain', shopDomain)
    .maybeSingle();

  if (error) {
    logWebhookError('[webhook] shop lookup failed', {
      code: error.code,
      details: error.details,
      hint: error.hint,
      message: error.message,
      shopDomain,
    });
    return null;
  }

  return data;
}

async function handleOrderWebhook({
  payload,
  shopDomain,
  supabase,
  topic,
}: {
  payload: unknown;
  shopDomain: string | null;
  supabase: NonNullable<SupabaseAdminClient>;
  topic: string;
}) {
  const resolvedShopDomain = resolveShopDomain(shopDomain, payload);

  if (!resolvedShopDomain) {
    logWebhookError('[webhook] order webhook missing shop domain', { topic });
    return;
  }

  const shop = await getActiveShopByDomain({ shopDomain: resolvedShopDomain, supabase });

  if (!shop) {
    logWebhookInfo('[webhook] no active shop for order webhook', { topic, resolvedShopDomain });
    return;
  }

  const orderNode = mapOrderWebhookToOrderNode(payload);

  if (!orderNode) {
    logWebhookError('[webhook] invalid order payload', { topic, resolvedShopDomain });
    return;
  }

  const result = await persistShopifyOrder({
    merchantAccountId: shop.merchant_account_id,
    orderNode,
    shopId: shop.id,
    supabaseServiceClient: supabase,
  });

  if (result.ok) {
    logWebhookInfo('[webhook] order persisted', {
      orderId: orderNode.id,
      topic,
      shopDomain: resolvedShopDomain,
    });
  } else {
    logWebhookError('[webhook] order persist failed', {
      error: result.error,
      orderId: orderNode.id,
      topic,
      shopDomain: resolvedShopDomain,
    });
  }
}

async function handleProductWebhook({
  payload,
  shopDomain,
  supabase,
  topic,
}: {
  payload: unknown;
  shopDomain: string | null;
  supabase: NonNullable<SupabaseAdminClient>;
  topic: string;
}) {
  const resolvedShopDomain = resolveShopDomain(shopDomain, payload);

  if (!resolvedShopDomain) {
    logWebhookError('[webhook] product webhook missing shop domain', { topic });
    return;
  }

  const shop = await getActiveShopByDomain({ shopDomain: resolvedShopDomain, supabase });

  if (!shop) {
    logWebhookInfo('[webhook] no active shop for product webhook', { topic, resolvedShopDomain });
    return;
  }

  const productNode = mapProductWebhookToProductNode(payload);

  if (!productNode) {
    logWebhookError('[webhook] invalid product payload', { topic, resolvedShopDomain });
    return;
  }

  const result = await persistShopifyProductWebhook({
    merchantAccountId: shop.merchant_account_id,
    productNode,
    supabaseServiceClient: supabase,
  });

  if (result.ok) {
    logWebhookInfo('[webhook] product persisted', {
      productId: productNode.id,
      topic,
      shopDomain: resolvedShopDomain,
    });
  } else {
    logWebhookError('[webhook] product persist failed', {
      error: result.error,
      productId: productNode.id,
      topic,
      shopDomain: resolvedShopDomain,
    });
  }
}

async function handleAppUninstalledWebhook({
  payload,
  shopDomain,
  supabase,
  topic,
}: {
  payload: unknown;
  shopDomain: string | null;
  supabase: NonNullable<SupabaseAdminClient>;
  topic: string;
}) {
  const resolvedShopDomain = resolveShopDomain(shopDomain, payload);

  if (!resolvedShopDomain) {
    logWebhookError('[webhook] app/uninstalled missing shop domain', { topic });
    return;
  }

  const shop = await getShopByDomain({ shopDomain: resolvedShopDomain, supabase });

  if (!shop) {
    logWebhookInfo('[webhook] app/uninstalled shop not found', { resolvedShopDomain });
    return;
  }

  // Désinstallation PAR BOUTIQUE : on marque UNIQUEMENT cette boutique (shop_domain unique)
  // uninstalled + on révoque ses tokens (le refresh + les expirations) → sa sync s'arrête
  // (les selects filtrent status='active'). Les autres boutiques et le compte ne sont pas touchés.
  const { error: updateError } = await supabase
    .from('shop')
    .update({
      status: 'uninstalled',
      uninstalled_at: new Date().toISOString(),
      refresh_token_encrypted: null,
      access_token_expires_at: null,
      refresh_token_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('shop_domain', resolvedShopDomain);

  if (updateError) {
    logWebhookError('[webhook] app/uninstalled update failed', {
      code: updateError.code,
      details: updateError.details,
      hint: updateError.hint,
      message: updateError.message,
      resolvedShopDomain,
    });
    return;
  }

  const { error: auditError } = await supabase.from('audit_log').insert({
    merchant_account_id: shop.merchant_account_id,
    actor_user_id: null,
    action: 'shopify.app_uninstalled',
    resource_type: 'shop',
    resource_id: shop.id,
    payload: { shopDomain: resolvedShopDomain },
  });

  if (auditError) {
    logWebhookError('[webhook] app/uninstalled audit failed', {
      code: auditError.code,
      details: auditError.details,
      hint: auditError.hint,
      message: auditError.message,
      resolvedShopDomain,
    });
    return;
  }

  logWebhookInfo('[webhook] app/uninstalled processed', { resolvedShopDomain });
}

async function handleRefundWebhook({
  payload,
  shopDomain,
  supabase,
  topic,
}: {
  payload: unknown;
  shopDomain: string | null;
  supabase: NonNullable<SupabaseAdminClient>;
  topic: string;
}) {
  const resolvedShopDomain = resolveShopDomain(shopDomain, payload);

  if (!resolvedShopDomain) {
    logWebhookError('[webhook] refund missing shop domain', { topic });
    return;
  }

  const shop = await getActiveShopByDomain({ shopDomain: resolvedShopDomain, supabase });

  if (!shop) {
    logWebhookInfo('[webhook] no active shop for refund webhook', { topic, resolvedShopDomain });
    return;
  }

  const refund = deriveRefundWebhook(payload);
  let localOrderId: string | null = null;

  if (refund.orderId) {
    const { data: localOrder, error: orderLookupError } = await supabase
      .from('orders')
      .select('id')
      .eq('merchant_account_id', shop.merchant_account_id)
      .eq('shopify_order_id', refund.orderId)
      .maybeSingle();

    if (orderLookupError) {
      logWebhookError('[webhook] refund order lookup failed', {
        error: orderLookupError.message,
        orderId: refund.orderId,
        resolvedShopDomain,
      });
    } else {
      localOrderId = localOrder?.id ?? null;
    }
  }

  if (refund.shouldUpdateFinancialStatus && localOrderId) {
    const { error: orderUpdateError } = await supabase
      .from('orders')
      .update({
        financial_status: 'partially_refunded',
        shopify_financial_status: 'partially_refunded',
        updated_at: new Date().toISOString(),
      })
      .eq('id', localOrderId);

    if (orderUpdateError) {
      logWebhookError('[webhook] refund order update failed', {
        error: orderUpdateError.message,
        localOrderId,
        orderId: refund.orderId,
        resolvedShopDomain,
      });
    }
  }

  await supabase.from('audit_log').insert({
    merchant_account_id: shop.merchant_account_id,
    actor_user_id: null,
    action: 'shopify.refund_received',
    resource_type: localOrderId ? 'orders' : 'shop',
    resource_id: localOrderId ?? shop.id,
    payload: toJson({
      cashStillHeldByTeer: refund.cashStillHeldByTeer,
      localOrderId,
      nonCashRefundedMinor: refund.nonCashRefundedMinor,
      orderId: refund.orderId,
      shopDomain: resolvedShopDomain,
      shouldUpdateFinancialStatus: refund.shouldUpdateFinancialStatus,
      successfulRefundCount: refund.successfulRefundCount,
      transactionSummary: refund.transactionSummary,
    }),
  });
}

// bulk_operations/finish : la bulk operation est terminée → traite le JSONL (fallback du polling).
async function handleBulkFinishWebhook({
  payload,
  shopDomain,
  supabase,
  topic,
}: {
  payload: unknown;
  shopDomain: string | null;
  supabase: NonNullable<SupabaseAdminClient>;
  topic: string;
}) {
  const resolvedShopDomain = resolveShopDomain(shopDomain, payload);
  if (!resolvedShopDomain) {
    logWebhookError('[webhook] bulk finish missing shop domain', { topic });
    return;
  }

  const { data: shop, error } = await supabase
    .from('shop')
    .select('*')
    .eq('shop_domain', resolvedShopDomain)
    .eq('status', 'active')
    .maybeSingle();

  if (error || !shop) {
    logWebhookInfo('[webhook] no active shop for bulk finish', { topic, resolvedShopDomain });
    return;
  }

  // Multi-app : credentials de l'app ayant installé cette boutique (fallback app par défaut).
  const app = getShopifyAppForShop(shop.shopify_client_id);
  if (!app) {
    logWebhookError('[webhook] bulk finish missing Shopify credentials', { topic });
    return;
  }

  const result = await processFinishedBulkForShop(supabase, shop, app.clientId, app.clientSecret);
  logWebhookInfo('[webhook] bulk finish processed', { resolvedShopDomain, ok: result.ok });
}

async function handleGdprWebhook({
  payload,
  shopDomain,
  supabase,
  topic,
}: {
  payload: unknown;
  shopDomain: string | null;
  supabase: NonNullable<SupabaseAdminClient>;
  topic: string;
}) {
  const resolvedShopDomain = resolveShopDomain(shopDomain, payload);

  logWebhookInfo(`[webhook] GDPR ${topic} received`, {
    payload,
    shopDomain: resolvedShopDomain,
  });

  if (!resolvedShopDomain) {
    logWebhookError('[webhook] GDPR audit skipped: missing shop domain', { topic });
    return;
  }

  const shop = await getShopByDomain({ shopDomain: resolvedShopDomain, supabase });

  if (!shop) {
    logWebhookError('[webhook] GDPR audit skipped: shop not found', {
      shopDomain: resolvedShopDomain,
      topic,
    });
    return;
  }

  // Identifiant client Shopify (numérique) depuis le payload, pour data_request / redact.
  const customerRecord = isRecord(payload) ? nestedRecord(payload, 'customer') : null;
  const shopifyCustomerId = customerRecord ? stringField(customerRecord, 'id') : null;

  let outcome: Json = { shopDomain: resolvedShopDomain, topic };
  try {
    switch (topic) {
      case 'customers/data_request': {
        if (!shopifyCustomerId) break;
        const data = await compileCustomerData(supabase, {
          merchantAccountId: shop.merchant_account_id,
          shopifyCustomerId,
        });
        // La donnée compilée est consignée pour que le marchand puisse la fournir au client.
        outcome = toJson({ compiled: data, shopDomain: resolvedShopDomain, topic });
        break;
      }
      case 'customers/redact': {
        if (!shopifyCustomerId) break;
        const result = await redactCustomer(supabase, {
          merchantAccountId: shop.merchant_account_id,
          shopifyCustomerId,
        });
        outcome = toJson({ ...result, shopDomain: resolvedShopDomain, topic });
        break;
      }
      case 'shop/redact': {
        const result = await redactShop(supabase, {
          merchantAccountId: shop.merchant_account_id,
          shopId: shop.id,
        });
        outcome = toJson({ ...result, shopDomain: resolvedShopDomain, topic });
        break;
      }
      default:
        break;
    }
  } catch (gdprError) {
    logWebhookError('[webhook] GDPR processing failed', { topic, shopDomain: resolvedShopDomain });
    throw gdprError;
  }

  const { error } = await supabase.from('audit_log').insert({
    merchant_account_id: shop.merchant_account_id,
    actor_user_id: null,
    action: `gdpr.${topic}`,
    resource_type: 'shop',
    resource_id: shop.id,
    payload: outcome,
  });

  if (error) {
    logWebhookError('[webhook] GDPR audit failed', {
      code: error.code,
      details: error.details,
      hint: error.hint,
      message: error.message,
      shopDomain: resolvedShopDomain,
      topic,
    });
  }
}

// Idempotence : insert dédup par webhook_id (contrainte unique). Un conflit (23505) = rejeu →
// duplicate. On stocke le contexte boutique/tenant + triggered_at + payload brut pour la
// réconciliation et la garde hors-ordre. Un rejeu identique n'a donc aucun effet métier.
async function recordWebhookReceipt({
  supabase,
  webhookId,
  topic,
  shopDomain,
  shopId,
  merchantAccountId,
  triggeredAt,
  payload,
}: {
  supabase: NonNullable<SupabaseAdminClient>;
  webhookId: string;
  topic: string;
  shopDomain: string | null;
  shopId: string | null;
  merchantAccountId: string | null;
  triggeredAt: string | null;
  payload: Json;
}): Promise<{ duplicate: boolean; eventId: string | null }> {
  const { data, error } = await supabase
    .from('webhook_event')
    .insert({
      shopify_webhook_id: webhookId,
      topic,
      shop_domain: shopDomain,
      shop_id: shopId,
      merchant_account_id: merchantAccountId,
      triggered_at: triggeredAt,
      payload,
      status: 'processing',
    })
    .select('id')
    .single();

  if (error) {
    if (error.code === '23505') {
      logWebhookInfo('[webhook] duplicate ignored', { topic, webhookId });
      return { duplicate: true, eventId: null };
    }

    logWebhookError('[webhook] dedup insert failed', {
      code: error.code,
      details: error.details,
      hint: error.hint,
      message: error.message,
      topic,
      webhookId,
    });
    return { duplicate: false, eventId: null };
  }

  return { duplicate: false, eventId: data.id };
}

async function markWebhookStatus({
  supabase,
  eventId,
  status,
}: {
  supabase: NonNullable<SupabaseAdminClient>;
  eventId: string;
  status: 'done' | 'error';
}) {
  const { error } = await supabase
    .from('webhook_event')
    .update({ status, processed: status === 'done' })
    .eq('id', eventId);

  if (error) {
    logWebhookError('[webhook] status update failed', {
      code: error.code,
      details: error.details,
      hint: error.hint,
      message: error.message,
      eventId,
      status,
    });
  }
}

async function processWebhook({
  payload,
  shopDomain,
  supabase,
  topic,
}: {
  payload: unknown;
  shopDomain: string | null;
  supabase: NonNullable<SupabaseAdminClient>;
  topic: string;
}) {
  switch (topic) {
    // orders/cancelled et orders/fulfilled portent un objet commande complet → miroir de canal
    // (shopify_*), JAMAIS les 4 dimensions. Un « fulfilled » Shopify ne marque pas LIVREE.
    case 'orders/create':
    case 'orders/updated':
    case 'orders/cancelled':
    case 'orders/fulfilled':
      await handleOrderWebhook({ payload, shopDomain, supabase, topic });
      break;
    case 'refunds/create':
      await handleRefundWebhook({ payload, shopDomain, supabase, topic });
      break;
    case 'bulk_operations/finish':
      await handleBulkFinishWebhook({ payload, shopDomain, supabase, topic });
      break;
    case 'products/create':
    case 'products/update':
      await handleProductWebhook({ payload, shopDomain, supabase, topic });
      break;
    case 'app/uninstalled':
      await handleAppUninstalledWebhook({ payload, shopDomain, supabase, topic });
      break;
    case 'customers/data_request':
    case 'customers/redact':
    case 'shop/redact':
      await handleGdprWebhook({ payload, shopDomain, supabase, topic });
      break;
    default:
      logWebhookInfo('[webhook] unhandled topic', topic);
      break;
  }
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const hmacHeader = request.headers.get('x-shopify-hmac-sha256');
  const topic = request.headers.get('x-shopify-topic') ?? 'unknown';
  const shopDomain = request.headers.get('x-shopify-shop-domain');
  const webhookId = request.headers.get('x-shopify-webhook-id');
  const triggeredAt = request.headers.get('x-shopify-triggered-at');

  const supabase = createSupabaseAdminClient();

  // Multi-app : on route le secret HMAC vers l'app émettrice. La boutique mémorise shopify_client_id
  // à l'install → on l'utilise (lookup par le header x-shopify-shop-domain, valeur non fiable mais
  // sans risque : un mauvais domaine sélectionne le mauvais secret → l'HMAC échoue → 401).
  // Boutique inconnue de la base (conformité, désinstallée, jamais installée) → on essaie TOUS les
  // secrets enregistrés pour rester vérifié sur les DEUX apps.
  const registeredSecrets = getRegisteredShopifyApps().map((app) => app.clientSecret);
  const fallbackSecrets =
    registeredSecrets.length > 0 ? registeredSecrets : [process.env.SHOPIFY_API_SECRET ?? ''];

  const headerShop =
    supabase && shopDomain ? await getShopByDomain({ shopDomain, supabase }) : null;
  const headerApp = headerShop ? getShopifyAppForShop(headerShop.shopify_client_id) : null;
  const hmacSecrets = headerApp ? [headerApp.clientSecret] : fallbackSecrets;

  // HMAC vérifié AVANT tout traitement.
  if (!verifyWebhookHmacAnySecret(rawBody, hmacHeader, hmacSecrets)) {
    logWebhookError('[webhook] invalid hmac', { topic });
    return new Response(null, { status: 401 });
  }

  if (!supabase) {
    logWebhookError('[webhook] missing supabase service-role env', { topic });
    return ok();
  }

  if (!webhookId) {
    logWebhookError('[webhook] missing webhook id', { topic });
    return ok();
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody) as unknown;
  } catch (error) {
    logWebhookError('[webhook] invalid json payload', { error, topic });
    return ok();
  }

  // Contexte boutique/tenant pour la ligne de dédup (résolution légère par domaine).
  // On réutilise la boutique déjà chargée pour le routage HMAC quand le domaine concorde.
  const resolvedShopDomain = resolveShopDomain(shopDomain, payload);
  const shop = resolvedShopDomain
    ? headerShop && headerShop.shop_domain === resolvedShopDomain
      ? headerShop
      : await getShopByDomain({ shopDomain: resolvedShopDomain, supabase })
    : null;

  // Idempotence : insert dédup par webhook_id. Rejeu → duplicate → 200 sans effet.
  const { duplicate, eventId } = await recordWebhookReceipt({
    supabase,
    webhookId,
    topic,
    shopDomain: resolvedShopDomain,
    shopId: shop?.id ?? null,
    merchantAccountId: shop?.merchant_account_id ?? null,
    triggeredAt,
    payload: toJson(payload),
  });

  if (duplicate) {
    return ok();
  }

  // 200 rapide (< 5 s) : le traitement métier s'exécute APRÈS la réponse (after()).
  // Les upserts sont idempotents par clé naturelle (shop_id, shopify_order_id) et la garde
  // hors-ordre protège ; un échec est rattrapé par la réconciliation nocturne (pas de retry).
  after(async () => {
    try {
      await processWebhook({ payload, shopDomain, supabase, topic });
      if (eventId) {
        await markWebhookStatus({ supabase, eventId, status: 'done' });
      }
    } catch (error) {
      logWebhookError('[webhook] async processing failed', { error, topic });
      if (eventId) {
        await markWebhookStatus({ supabase, eventId, status: 'error' });
      }
    }
  });

  return ok();
}
