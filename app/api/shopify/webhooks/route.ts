import {
  dualWriteBulkOperationFinishedWebhook,
  dualWriteOrderWebhook,
  dualWriteProductWebhook,
  dualWriteRefundWebhook,
} from '@/lib/ingestion/shopify-dual-write';
import { writePcdAccessAudit } from '@/lib/security/pcd-access-audit';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { getRegisteredShopifyApps, getShopifyAppForShop } from '@/lib/shopify/apps';
import { createPrivateDsarArtifact } from '@/lib/shopify/dsar';
import {
  compileCustomerData,
  redactCustomer,
  redactShop,
  toGdprAuditPayload,
} from '@/lib/shopify/gdpr';
import {
  type ShopifyAddress,
  type ShopifyCustomAttribute,
  type ShopifyCustomerNode,
  type ShopifyOrderNode,
  persistShopifyOrder,
} from '@/lib/shopify/orders-sync';
import { type ShopifyProductNode, persistShopifyProductWebhook } from '@/lib/shopify/products-sync';
import { processFinishedBulkForShop } from '@/lib/shopify/reconcile';
import { deriveRefundWebhook } from '@/lib/shopify/refunds';
import { verifyWebhookHmacAnySecret } from '@/lib/shopify/webhook-verify';
import type { Database, Json } from '@/lib/supabase/database.types';
import * as Sentry from '@sentry/nextjs';
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

const CONTROLLED_WEBHOOK_ERROR_CODES = new Set([
  'gdpr_shop_domain_missing',
  'gdpr_shop_domain_mismatch',
  'gdpr_shop_lookup_failed',
  'gdpr_shop_not_found',
  'gdpr_customer_id_missing',
  'gdpr_topic_not_supported',
  'gdpr_customer_lookup_failed',
  'gdpr_customer_shop_scope_lookup_failed',
  'gdpr_customer_export_failed',
  'gdpr_order_export_failed',
  'gdpr_delivery_address_export_failed',
  'gdpr_redaction_failed',
  'gdpr_audit_failed',
  'dsar_artifact_metadata_failed',
  'dsar_artifact_metadata_missing',
  'dsar_artifact_upload_failed',
  'dsar_artifact_finalize_failed',
  'shopify_order_persist_failed',
  'shopify_product_persist_failed',
  'shopify_refund_order_lookup_failed',
  'shopify_refund_order_update_failed',
  'shopify_refund_audit_failed',
  'shopify_pcd_audit_failed',
  'shopify_uninstall_shop_domain_missing',
  'shopify_uninstall_shop_domain_mismatch',
]);

function sanitizeWebhookError(error: unknown): string {
  const raw = error instanceof Error ? error.message : '';
  return CONTROLLED_WEBHOOK_ERROR_CODES.has(raw) ? raw : 'internal_processing_error';
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

// Attributs clé/valeur REST : note_attributes (commande) et line_items[].properties (ligne)
// portent tous deux la forme { name, value } — normalisée vers { key, value } (forme GraphQL).
function mapWebhookCustomAttributes(value: unknown): ShopifyCustomAttribute[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const attributes: ShopifyCustomAttribute[] = [];
  for (const entry of value) {
    if (isRecord(entry)) {
      const key = stringField(entry, 'name');
      if (key) {
        attributes.push({ key, value: stringField(entry, 'value') });
      }
    }
  }
  return attributes;
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

// Champs PCD strictement nécessaires depuis le bloc customer d'un webhook commande REST.
function mapWebhookCustomer(
  customer: Record<string, unknown>,
  customerId: string,
  shippingAddress: Record<string, unknown> | null,
  shippingName: string | null,
): ShopifyCustomerNode {
  return {
    id: customerId,
    displayName: buildCustomerName(customer, shippingName),
    firstName: stringField(customer, 'first_name'),
    lastName: stringField(customer, 'last_name'),
    phone: stringField(customer, 'phone') ?? nullableStringField(shippingAddress, 'phone'),
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
    note: stringField(payload, 'note'),
    customAttributes: mapWebhookCustomAttributes(payload.note_attributes),
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
          customAttributes: mapWebhookCustomAttributes(lineItem.properties),
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

type SignedShopDomainResult =
  | { ok: true; shopDomain: string }
  | { ok: false; reason: 'missing' | 'mismatch' };

// Résolution AUTORITATIVE de la boutique pour les topics dont le corps signé porte l'identité
// (customers/data_request, customers/redact, shop/redact, app/uninstalled) — PAS pour orders/*,
// products/*, refunds/create, bulk_operations/finish, dont le corps Shopify ne contient jamais
// de shop_domain/shop_id (vérifié contre les fixtures E2E de ce dépôt, incident 2026-08-23).
//
// x-shopify-hmac-sha256 ne couvre QUE le corps brut — jamais les en-têtes. x-shopify-shop-domain
// n'est donc pas authentifié. Un secret d'app Shopify est partagé par TOUTES les boutiques
// installées sous cette app (lib/shopify/apps.ts : 4 apps fixes, dont teer-dev = app publique par
// défaut) — un HMAC valide prouve seulement « signé par une boutique de cette app », jamais
// laquelle. Un attaquant capturant un (rawBody, hmac) valide pour SA PROPRE boutique peut donc le
// rejouer avec un x-shopify-shop-domain forgé désignant une boutique VICTIME de la même app, tant
// que rien ne confronte le domaine du header à celui du corps signé.
//
// Contrat : le shop_domain du CORPS est la seule source de confiance ; le header n'est comparé à
// titre de garde-fou. Toute divergence, ou absence des deux, refuse AVANT toute écriture.
// `allowHeaderFallback` n'existe que pour app/uninstalled, dont le corps peut arriver vide selon
// le SDK Shopify (comportement Shopify externe, non vérifiable depuis ce dépôt) — ne jamais le
// passer à true pour un autre appelant.
function resolveSignedShopDomain(
  headerShopDomain: string | null,
  payload: unknown,
  { allowHeaderFallback = false }: { allowHeaderFallback?: boolean } = {},
): SignedShopDomainResult {
  const bodyShopDomain = isRecord(payload)
    ? (stringField(payload, 'shop_domain') ?? stringField(payload, 'myshopify_domain'))
    : null;

  if (bodyShopDomain) {
    if (headerShopDomain && headerShopDomain !== bodyShopDomain) {
      return { ok: false, reason: 'mismatch' };
    }
    return { ok: true, shopDomain: bodyShopDomain };
  }

  if (allowHeaderFallback && headerShopDomain) {
    return { ok: true, shopDomain: headerShopDomain };
  }

  return { ok: false, reason: 'missing' };
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
    .select('id, merchant_account_id, shop_domain, shopify_client_id')
    .eq('shop_domain', shopDomain)
    .eq('store_kind', 'shopify')
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

async function getGdprShopByDomain({
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
    throw new Error('gdpr_shop_lookup_failed');
  }
  return data;
}

// Double écriture best-effort — ne doit JAMAIS faire échouer le chemin legacy qui reste
// autoritatif en lecture dans ce lot (aucune bascule). Toute erreur est absorbée ici, jamais
// laissée remonter au handler appelant.
async function runDualWrite(label: string, work: () => Promise<void>) {
  try {
    await work();
  } catch (error) {
    logWebhookError(`[ingestion] dual-write failed (${label})`, {
      message: error instanceof Error ? error.message : String(error),
    });
    Sentry.captureException(error, {
      tags: { module: 'shopify.webhooks', dualWriteLabel: label },
    });
  }
}

async function handleOrderWebhook({
  payload,
  shopDomain,
  supabase,
  topic,
  webhookId,
  triggeredAt,
}: {
  payload: unknown;
  shopDomain: string | null;
  supabase: NonNullable<SupabaseAdminClient>;
  topic: string;
  webhookId: string | null;
  triggeredAt: string | null;
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
    await runDualWrite('order', () =>
      dualWriteOrderWebhook({
        supabase,
        shop,
        topic,
        orderNode,
        deliveryId: webhookId,
        triggeredAt,
      }),
    );
  } else {
    logWebhookError('[webhook] order persist failed', {
      errorCode: sanitizeWebhookError(result.error),
      orderId: orderNode.id,
      topic,
      shopDomain: resolvedShopDomain,
    });
    throw new Error('shopify_order_persist_failed');
  }
}

async function handleProductWebhook({
  payload,
  shopDomain,
  supabase,
  topic,
  webhookId,
  triggeredAt,
}: {
  payload: unknown;
  shopDomain: string | null;
  supabase: NonNullable<SupabaseAdminClient>;
  topic: string;
  webhookId: string | null;
  triggeredAt: string | null;
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
    shopId: shop.id,
    supabaseServiceClient: supabase,
  });

  if (result.ok) {
    logWebhookInfo('[webhook] product persisted', {
      productId: productNode.id,
      topic,
      shopDomain: resolvedShopDomain,
    });
    await runDualWrite('product', () =>
      dualWriteProductWebhook({
        supabase,
        shop,
        topic,
        productNode,
        deliveryId: webhookId,
        triggeredAt,
      }),
    );
  } else {
    logWebhookError('[webhook] product persist failed', {
      errorCode: sanitizeWebhookError(result.error),
      productId: productNode.id,
      topic,
      shopDomain: resolvedShopDomain,
    });
    throw new Error('shopify_product_persist_failed');
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
  // Corps signé autoritatif ; le header n'est qu'un garde-fou comparé, jamais la seule source
  // (cf. resolveSignedShopDomain — incident cross-tenant 2026-08-23). Le corps app/uninstalled
  // peut arriver vide selon le SDK Shopify → seul topic autorisé à retomber sur le header seul.
  const resolved = resolveSignedShopDomain(shopDomain, payload, { allowHeaderFallback: true });

  if (!resolved.ok) {
    if (resolved.reason === 'mismatch') {
      logWebhookError('[webhook] app/uninstalled shop domain mismatch', {
        topic,
        headerShopDomain: shopDomain,
      });
      throw new Error('shopify_uninstall_shop_domain_mismatch');
    }
    logWebhookError('[webhook] app/uninstalled missing shop domain', { topic });
    throw new Error('shopify_uninstall_shop_domain_missing');
  }

  const resolvedShopDomain = resolved.shopDomain;

  const shop = await getShopByDomain({ shopDomain: resolvedShopDomain, supabase });

  if (!shop) {
    logWebhookInfo('[webhook] app/uninstalled shop not found', { resolvedShopDomain });
    return;
  }

  // Désinstallation PAR BOUTIQUE : on marque UNIQUEMENT cette boutique uninstalled + on révoque
  // ses tokens (le refresh + les expirations) → sa sync s'arrête (les selects filtrent
  // status='active'). Les autres boutiques et le compte ne sont pas touchés.
  // Défense en profondeur : shop_domain seul reste la clé la plus fragile même une fois le
  // domaine confirmé par le corps signé — id et merchant_account_id (déjà en main depuis le
  // SELECT ci-dessus) sont ajoutés pour qu'aucune écriture ne repose sur une seule colonne.
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
    .eq('id', shop.id)
    .eq('merchant_account_id', shop.merchant_account_id)
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

  // Best-effort : ne bloque jamais le traitement principal (shop.status déjà posé ci-dessus).
  await runDualWrite('app_uninstalled_connection_status', async () => {
    await supabase
      .from('store_connection')
      .update({ status: 'uninstalled', uninstalled_at: new Date().toISOString() })
      .eq('platform', 'shopify')
      .eq('external_identifier', resolvedShopDomain);
  });

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
  webhookId,
  triggeredAt,
}: {
  payload: unknown;
  shopDomain: string | null;
  supabase: NonNullable<SupabaseAdminClient>;
  topic: string;
  webhookId: string | null;
  triggeredAt: string | null;
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
        errorCode: sanitizeWebhookError(orderLookupError.message),
        orderId: refund.orderId,
        resolvedShopDomain,
      });
      throw new Error('shopify_refund_order_lookup_failed');
    }
    localOrderId = localOrder?.id ?? null;
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
        errorCode: sanitizeWebhookError(orderUpdateError.message),
        localOrderId,
        orderId: refund.orderId,
        resolvedShopDomain,
      });
      throw new Error('shopify_refund_order_update_failed');
    }
  }

  const { error: refundAuditError } = await supabase.from('audit_log').insert({
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
  if (refundAuditError) {
    throw new Error('shopify_refund_audit_failed');
  }

  await runDualWrite('refund', () =>
    dualWriteRefundWebhook({
      supabase,
      shop,
      topic,
      orderId: refund.orderId,
      deliveryId: webhookId,
      triggeredAt,
    }),
  );
}

// bulk_operations/finish : la bulk operation est terminée → traite le JSONL (fallback du polling).
async function handleBulkFinishWebhook({
  payload,
  shopDomain,
  supabase,
  topic,
  webhookId,
  triggeredAt,
}: {
  payload: unknown;
  shopDomain: string | null;
  supabase: NonNullable<SupabaseAdminClient>;
  topic: string;
  webhookId: string | null;
  triggeredAt: string | null;
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

  await runDualWrite('bulk_operation_finished', () =>
    dualWriteBulkOperationFinishedWebhook({
      supabase,
      shop,
      topic,
      deliveryId: webhookId,
      triggeredAt,
    }),
  );
}

type GdprProcessResult = {
  proof: {
    customer_count: number;
    order_count: number;
    delivery_address_count: number;
    tombstone_count: number;
    webhook_payload_count: number;
  };
  artifactId: string | null;
  artifactExpiresAt: string | null;
};

async function handleGdprWebhook({
  eventId,
  payload,
  shopDomain,
  supabase,
  topic,
}: {
  eventId: string;
  payload: unknown;
  shopDomain: string | null;
  supabase: NonNullable<SupabaseAdminClient>;
  topic: string;
}): Promise<GdprProcessResult> {
  // Corps signé autoritatif ; le header n'est qu'un garde-fou comparé, jamais la seule source
  // (cf. resolveSignedShopDomain — incident cross-tenant 2026-08-23). Les 3 topics GDPR portent
  // shop_domain dans leur corps signé (vérifié contre les fixtures E2E de ce dépôt) : aucun
  // repli sur le header n'est autorisé ici.
  const resolved = resolveSignedShopDomain(shopDomain, payload);

  if (!resolved.ok) {
    if (resolved.reason === 'mismatch') {
      logWebhookError(`[webhook] GDPR ${topic} shop domain mismatch`, {
        topic,
        headerShopDomain: shopDomain,
      });
      throw new Error('gdpr_shop_domain_mismatch');
    }
    throw new Error('gdpr_shop_domain_missing');
  }

  const resolvedShopDomain = resolved.shopDomain;

  logWebhookInfo(`[webhook] GDPR ${topic} received`, {
    shopDomain: resolvedShopDomain,
  });

  const shop = await getGdprShopByDomain({ shopDomain: resolvedShopDomain, supabase });

  if (!shop) {
    throw new Error('gdpr_shop_not_found');
  }

  // Identifiant client Shopify (numérique) depuis le payload, pour data_request / redact.
  const customerRecord = isRecord(payload) ? nestedRecord(payload, 'customer') : null;
  const shopifyCustomerId = customerRecord ? stringField(customerRecord, 'id') : null;

  let proof: GdprProcessResult['proof'] = {
    customer_count: 0,
    order_count: 0,
    delivery_address_count: 0,
    tombstone_count: 0,
    webhook_payload_count: 0,
  };
  let artifactId: string | null = null;
  let artifactExpiresAt: string | null = null;

  switch (topic) {
    case 'customers/data_request': {
      if (!shopifyCustomerId) {
        throw new Error('gdpr_customer_id_missing');
      }
      const data = await compileCustomerData(supabase, {
        merchantAccountId: shop.merchant_account_id,
        shopId: shop.id,
        shopifyCustomerId,
      });
      const artifact = await createPrivateDsarArtifact(supabase, {
        eventId,
        merchantAccountId: shop.merchant_account_id,
        shopId: shop.id,
        data,
      });
      artifactId = artifact.artifactId;
      artifactExpiresAt = artifact.expiresAt;
      proof = {
        customer_count: data.customers.length,
        order_count: data.orders.length,
        delivery_address_count: data.delivery_addresses.length,
        tombstone_count: 0,
        webhook_payload_count: 0,
      };
      break;
    }
    case 'customers/redact': {
      if (!shopifyCustomerId) {
        throw new Error('gdpr_customer_id_missing');
      }
      proof = await redactCustomer(supabase, {
        merchantAccountId: shop.merchant_account_id,
        shopId: shop.id,
        shopifyCustomerId,
        webhookEventId: eventId,
      });
      break;
    }
    case 'shop/redact':
      proof = await redactShop(supabase, {
        merchantAccountId: shop.merchant_account_id,
        shopId: shop.id,
        webhookEventId: eventId,
      });
      break;
    default:
      throw new Error('gdpr_topic_not_supported');
  }

  const { error } = await supabase.from('audit_log').insert({
    merchant_account_id: shop.merchant_account_id,
    actor_user_id: null,
    action: `gdpr.${topic}`,
    resource_type: 'shop',
    resource_id: shop.id,
    payload: toGdprAuditPayload({
      topic,
      status: 'done',
      artifactId,
      artifactExpiresAt,
      proof,
    }),
  });

  if (error) {
    throw new Error('gdpr_audit_failed');
  }

  return { proof, artifactId, artifactExpiresAt };
}

// Idempotence : insert dédup par webhook_id (contrainte unique). Un conflit
// retrouve l'état durable : done/terminal sont ignorés, retryable est réclamé
// à nouveau après son échéance.
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
}): Promise<{
  duplicate: boolean;
  eventId: string | null;
  status: string | null;
  payload: Json | null;
  nextAttemptAt: string | null;
  error: boolean;
}> {
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
      attempt_count: 1,
      lease_until: new Date(Date.now() + 5 * 60_000).toISOString(),
    })
    .select('id')
    .single();

  if (error) {
    if (error.code === '23505') {
      const { data: existing, error: existingError } = await supabase
        .from('webhook_event')
        .select('id, status, payload, next_attempt_at')
        .eq('shopify_webhook_id', webhookId)
        .maybeSingle();
      if (existingError || !existing) {
        logWebhookError('[webhook] duplicate lookup failed', { topic, webhookId });
        return {
          duplicate: true,
          eventId: null,
          status: null,
          payload: null,
          nextAttemptAt: null,
          error: true,
        };
      }
      logWebhookInfo('[webhook] duplicate received', { topic, webhookId, status: existing.status });
      return {
        duplicate: true,
        eventId: existing.id,
        status: existing.status,
        payload: existing.payload,
        nextAttemptAt: existing.next_attempt_at,
        error: false,
      };
    }

    logWebhookError('[webhook] dedup insert failed', {
      code: error.code,
      details: error.details,
      hint: error.hint,
      message: error.message,
      topic,
      webhookId,
    });
    return {
      duplicate: false,
      eventId: null,
      status: null,
      payload: null,
      nextAttemptAt: null,
      error: true,
    };
  }

  return {
    duplicate: false,
    eventId: data.id,
    status: 'processing',
    payload,
    nextAttemptAt: null,
    error: false,
  };
}

async function finishWebhookStatus({
  supabase,
  eventId,
  outcome,
  errorCode,
  proof,
}: {
  supabase: NonNullable<SupabaseAdminClient>;
  eventId: string;
  outcome: 'done' | 'retryable' | 'terminal';
  errorCode?: string;
  proof?: Json;
}) {
  const { data, error } = await supabase.rpc('finish_shopify_webhook_event', {
    p_event_id: eventId,
    p_outcome: outcome,
    p_error_code: errorCode,
    p_proof: proof,
  });
  if (error || data !== true) {
    logWebhookError('[webhook] durable status update failed', {
      eventId,
      outcome,
      code: error?.code ?? 'not_claimed',
    });
  }
}

function isTerminalWebhookError(error: unknown): boolean {
  const code = sanitizeWebhookError(error);
  return new Set([
    'gdpr_shop_domain_missing',
    'gdpr_shop_domain_mismatch',
    'gdpr_shop_not_found',
    'gdpr_customer_id_missing',
    'gdpr_topic_not_supported',
    'shopify_uninstall_shop_domain_missing',
    'shopify_uninstall_shop_domain_mismatch',
  ]).has(code);
}

async function processWebhook({
  eventId,
  payload,
  shopDomain,
  supabase,
  topic,
  webhookId,
  triggeredAt,
}: {
  eventId: string;
  payload: unknown;
  shopDomain: string | null;
  supabase: NonNullable<SupabaseAdminClient>;
  topic: string;
  webhookId: string | null;
  triggeredAt: string | null;
}): Promise<GdprProcessResult | null> {
  const pcdTopics = new Set([
    'orders/create',
    'orders/updated',
    'orders/cancelled',
    'orders/fulfilled',
    'bulk_operations/finish',
    'customers/data_request',
    'customers/redact',
    'shop/redact',
  ]);
  // Pré-audit PCD : pour les 3 topics GDPR (corps signé porteur de shop_domain), la même
  // confrontation corps/header que handleGdprWebhook s'applique ici — sinon cette écriture
  // d'audit se produirait AVANT le refus déclenché plus bas dans le dispatcher, avec un
  // merchant_account_id/shop_id potentiellement forgé (incident cross-tenant 2026-08-23).
  // orders/*/bulk_operations/finish restent sur le header seul : leur corps Shopify ne porte
  // structurellement aucune identité boutique signée (cf. rapport Lot H), rien à confronter.
  const isGdprSignedTopic =
    topic === 'customers/data_request' || topic === 'customers/redact' || topic === 'shop/redact';
  const pcdShopDomain = isGdprSignedTopic
    ? (() => {
        const resolved = resolveSignedShopDomain(shopDomain, payload);
        return resolved.ok ? resolved.shopDomain : null;
      })()
    : shopDomain;

  if (pcdTopics.has(topic) && pcdShopDomain) {
    const shop = await getShopByDomain({ shopDomain: pcdShopDomain, supabase });
    if (shop) {
      try {
        await writePcdAccessAudit(supabase, {
          tenantId: shop.merchant_account_id,
          shopId: shop.id,
          actorKind: 'service',
          serviceKind: 'webhook',
          action: 'privileged_read',
          dataCategory: 'shopify_payload',
          purpose:
            topic.startsWith('customers/') || topic === 'shop/redact'
              ? 'legal_request'
              : 'system_processing',
          outcome: 'allowed',
          resourceType: 'shopify_payload',
          resourceId: eventId,
          surface: 'shopify',
          metadata: { source: 'webhook' },
          idempotencyKey: `webhook:${eventId}:pcd-read`,
        });
      } catch {
        throw new Error('shopify_pcd_audit_failed');
      }
    }
  }

  switch (topic) {
    // orders/cancelled et orders/fulfilled portent un objet commande complet → miroir de canal
    // (shopify_*), JAMAIS les 4 dimensions. Un « fulfilled » Shopify ne marque pas LIVREE.
    case 'orders/create':
    case 'orders/updated':
    case 'orders/cancelled':
    case 'orders/fulfilled':
      await handleOrderWebhook({ payload, shopDomain, supabase, topic, webhookId, triggeredAt });
      return null;
    case 'refunds/create':
      await handleRefundWebhook({ payload, shopDomain, supabase, topic, webhookId, triggeredAt });
      return null;
    case 'bulk_operations/finish':
      await handleBulkFinishWebhook({
        payload,
        shopDomain,
        supabase,
        topic,
        webhookId,
        triggeredAt,
      });
      return null;
    case 'products/create':
    case 'products/update':
      await handleProductWebhook({ payload, shopDomain, supabase, topic, webhookId, triggeredAt });
      return null;
    case 'app/uninstalled':
      await handleAppUninstalledWebhook({ payload, shopDomain, supabase, topic });
      return null;
    case 'customers/data_request':
    case 'customers/redact':
    case 'shop/redact':
      return handleGdprWebhook({ eventId, payload, shopDomain, supabase, topic });
    default:
      logWebhookInfo('[webhook] unhandled topic', topic);
      return null;
  }
}

async function runWebhookEvent({
  eventId,
  payload,
  shopDomain,
  supabase,
  topic,
  replay,
  webhookId,
  triggeredAt,
}: {
  eventId: string;
  payload: unknown;
  shopDomain: string | null;
  supabase: NonNullable<SupabaseAdminClient>;
  topic: string;
  replay: boolean;
  webhookId: string | null;
  triggeredAt: string | null;
}) {
  let effectivePayload = payload;
  let effectiveShopDomain = shopDomain;
  let effectiveTopic = topic;

  if (replay) {
    const { data: claimed, error } = await supabase.rpc('claim_shopify_webhook_events', {
      p_event_id: eventId,
      p_limit: 1,
    });
    if (error) {
      logWebhookError('[webhook] retry claim failed', { eventId, code: error.code });
      return;
    }
    const event = claimed?.[0];
    if (!event || event.payload === null) {
      return;
    }
    effectivePayload = event.payload;
    effectiveShopDomain = event.shop_domain;
    effectiveTopic = event.topic;
  }

  try {
    const result = await processWebhook({
      eventId,
      payload: effectivePayload,
      shopDomain: effectiveShopDomain,
      supabase,
      topic: effectiveTopic,
      webhookId,
      triggeredAt,
    });
    await finishWebhookStatus({
      supabase,
      eventId,
      outcome: 'done',
      proof: result
        ? toJson({
            ...result.proof,
            artifact_id: result.artifactId,
            artifact_expires_at: result.artifactExpiresAt,
          })
        : undefined,
    });
  } catch (error) {
    const errorCode = sanitizeWebhookError(error);
    const outcome = isTerminalWebhookError(error) ? 'terminal' : 'retryable';
    logWebhookError('[webhook] async processing failed', {
      eventId,
      topic: effectiveTopic,
      outcome,
      errorCode,
    });
    await finishWebhookStatus({
      supabase,
      eventId,
      outcome,
      errorCode,
    });
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
  if (resolvedShopDomain) {
    const rateLimit = await checkRateLimit('shopify_webhook', `webhook:${resolvedShopDomain}`);
    if (!rateLimit.ok) {
      logWebhookError('[webhook] rate limit exceeded', { topic, resolvedShopDomain });
      return new Response(null, { headers: { 'retry-after': '60' }, status: 429 });
    }
  }

  const shop = resolvedShopDomain
    ? headerShop && headerShop.shop_domain === resolvedShopDomain
      ? headerShop
      : await getShopByDomain({ shopDomain: resolvedShopDomain, supabase })
    : null;

  // Idempotence : insert dédup par webhook_id. Un événement retryable arrivé
  // à échéance est réclamé à nouveau dans after().
  const receipt = await recordWebhookReceipt({
    supabase,
    webhookId,
    topic,
    shopDomain: resolvedShopDomain,
    shopId: shop?.id ?? null,
    merchantAccountId: shop?.merchant_account_id ?? null,
    triggeredAt,
    payload: toJson(payload),
  });

  if (receipt.error) {
    return new Response(null, { status: 503 });
  }

  if (receipt.duplicate) {
    const due =
      receipt.status === 'retryable' &&
      (receipt.nextAttemptAt === null || Date.parse(receipt.nextAttemptAt) <= Date.now());
    if (due && receipt.eventId) {
      after(() =>
        runWebhookEvent({
          eventId: receipt.eventId as string,
          payload: receipt.payload,
          shopDomain,
          supabase,
          topic,
          replay: true,
          webhookId,
          triggeredAt,
        }),
      );
    }
    return ok();
  }

  // 200 rapide (< 5 s) : le traitement métier s'exécute APRÈS la réponse (after()).
  after(() =>
    runWebhookEvent({
      eventId: receipt.eventId as string,
      payload,
      shopDomain,
      supabase,
      topic,
      replay: false,
      webhookId,
      triggeredAt,
    }),
  );

  return ok();
}
