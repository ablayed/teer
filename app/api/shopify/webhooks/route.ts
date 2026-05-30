import { type ShopifyOrderNode, persistShopifyOrder } from '@/lib/shopify/orders-sync';
import { verifyWebhookHmac } from '@/lib/shopify/webhook-verify';
import type { Database } from '@/lib/supabase/database.types';
import { createClient } from '@supabase/supabase-js';

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
        ? {
            id: customerId,
            displayName: buildCustomerName(customer, shippingName),
            phone: stringField(customer, 'phone') ?? nullableStringField(shippingAddress, 'phone'),
            email: stringField(customer, 'email'),
          }
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
          quantity: numberField(lineItem, 'quantity'),
          originalUnitPriceSet: {
            shopMoney: {
              amount: stringField(lineItem, 'price') ?? '0',
            },
          },
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

async function insertWebhookEvent({
  supabase,
  webhookId,
  topic,
  shopDomain,
}: {
  supabase: NonNullable<SupabaseAdminClient>;
  webhookId: string;
  topic: string;
  shopDomain: string | null;
}): Promise<{ duplicate: boolean; eventId: string | null }> {
  const { data, error } = await supabase
    .from('webhook_event')
    .insert({
      shopify_webhook_id: webhookId,
      topic,
      shop_domain: shopDomain,
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

async function markWebhookProcessed({
  supabase,
  eventId,
}: {
  supabase: NonNullable<SupabaseAdminClient>;
  eventId: string;
}) {
  const { error } = await supabase
    .from('webhook_event')
    .update({ processed: true })
    .eq('id', eventId);

  if (error) {
    logWebhookError('[webhook] processed update failed', {
      code: error.code,
      details: error.details,
      hint: error.hint,
      message: error.message,
      eventId,
    });
  }
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const hmacHeader = request.headers.get('x-shopify-hmac-sha256');
  const topic = request.headers.get('x-shopify-topic') ?? 'unknown';
  const shopDomain = request.headers.get('x-shopify-shop-domain');
  const webhookId = request.headers.get('x-shopify-webhook-id');

  if (!verifyWebhookHmac(rawBody, hmacHeader, process.env.SHOPIFY_API_SECRET ?? '')) {
    logWebhookError('[webhook] invalid hmac', { topic });
    return new Response(null, { status: 401 });
  }

  const supabase = createSupabaseAdminClient();

  if (!supabase) {
    logWebhookError('[webhook] missing supabase service-role env', { topic });
    return ok();
  }

  if (!webhookId) {
    logWebhookError('[webhook] missing webhook id', { topic });
    return ok();
  }

  const { duplicate, eventId } = await insertWebhookEvent({
    supabase,
    webhookId,
    topic,
    shopDomain,
  });

  if (duplicate) {
    return ok();
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody) as unknown;
  } catch (error) {
    logWebhookError('[webhook] invalid json payload', { error, topic });
    return ok();
  }

  switch (topic) {
    case 'orders/create':
    case 'orders/updated':
      await handleOrderWebhook({ payload, shopDomain, supabase, topic });
      break;
    case 'app/uninstalled':
      logWebhookInfo('[webhook] app/uninstalled received');
      break;
    case 'customers/data_request':
    case 'customers/redact':
    case 'shop/redact':
      logWebhookInfo('[webhook] gdpr received', topic);
      break;
    default:
      logWebhookInfo('[webhook] unhandled topic', topic);
      break;
  }

  if (eventId) {
    await markWebhookProcessed({ supabase, eventId });
  }

  return ok();
}
