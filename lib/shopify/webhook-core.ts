// Phase 2 — Verrou 0 : cœur de traitement webhook Shopify PARTAGÉ entre l'endpoint legacy
// (app/api/shopify/webhooks/route.ts, en-tête x-shopify-shop-domain) et l'endpoint à URL opaque
// (app/api/shopify/ingest/[token]/route.ts, jeton → connexion → recoupement d'app → HMAC).
//
// Ce module NE LIT JAMAIS d'en-tête, de jeton ni d'URL — il reçoit un contexte déjà résolu
// (`shop`, un objet WebhookShopRow, ou null) et ne sait pas d'où il vient. Chaque endpoint résout
// son contexte à sa manière (cf. les deux route.ts), puis appelle les fonctions ci-dessous.
//
// Tout ce qui suit vivait auparavant DUPLIQUÉ ou ABSENT sur l'endpoint opaque — désormais unique :
//   - écriture et cycle d'états de webhook_event (recordWebhookReceipt/finishWebhookStatus),
//     y compris la clé d'idempotence par livraison (contrainte unique shopify_webhook_id) ;
//   - mapping du payload REST Shopify (mapOrderWebhookToOrderNode/mapProductWebhookToProductNode)
//     et persistance (persistShopifyOrder/persistShopifyProductWebhook), garde hors-ordre incluse
//     (interne à persistShopifyOrder via isStaleShopifyUpdate, lib/shopify/orders-sync.ts) ;
//   - refunds/create avec son idempotence métier (migration 0144, record_shopify_refund_receipt) ;
//   - app/uninstalled (shop + store_connection + audit_log) — REMPLACE la copie qui vivait dans
//     app/api/shopify/ingest/[token]/route.ts (lot précédent, dédupliquée ici) ;
//   - double écriture L2 vers ingestion_event/external_ref (déjà partagée via
//     lib/ingestion/shopify-dual-write.ts, appelée identiquement par les deux chemins) ;
//   - journalisation d'audit et pré-audit PCD.
import {
  dualWriteBulkOperationFinishedWebhook,
  dualWriteOrderWebhook,
  dualWriteProductWebhook,
  dualWriteRefundWebhook,
  resolveShopConnection,
} from '@/lib/ingestion/shopify-dual-write';
import { writePcdAccessAudit } from '@/lib/security/pcd-access-audit';
import { getShopifyAppForShop } from '@/lib/shopify/apps';
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
import type { Database, Json, Tables } from '@/lib/supabase/database.types';
import { nullableRpcArg } from '@/lib/supabase/rpc-args';
import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

type AdminClient = SupabaseClient<Database>;

function logWebhookInfo(message: string, ...details: unknown[]) {
  // biome-ignore lint/suspicious/noConsole: journal opérationnel du pipeline webhook (partagé).
  console.log(message, ...details);
}

function logWebhookError(message: string, ...details: unknown[]) {
  // biome-ignore lint/suspicious/noConsole: journal opérationnel du pipeline webhook (partagé).
  console.error(message, ...details);
}

// ── Contexte boutique résolu — jamais un domaine, jamais un jeton ──────────────────────────────
// Ligne COMPLÈTE (pas une projection) : processBulkFinishCore a besoin des colonnes de jeton
// (access_token_encrypted, refresh_token_encrypted, expirations) via getValidShopAccessToken —
// exactement ce que sélectionnait déjà l'ancien handleBulkFinishWebhook (`select('*')`).
export type WebhookShopRow = Tables<'shop'>;

export type WebhookShopLocator =
  | { by: 'domain'; shopDomain: string }
  | { by: 'id'; shopId: string };

function applyLocator<T>(
  query: T,
  locator: WebhookShopLocator,
  // biome-ignore lint/suspicious/noExplicitAny: chaînage de query builder Supabase, typé au retour par l'appelant.
): any {
  // biome-ignore lint/suspicious/noExplicitAny: idem.
  const q = query as any;
  return locator.by === 'domain'
    ? q.eq('shop_domain', locator.shopDomain)
    : q.eq('id', locator.shopId);
}

// Résolution LENIENTE (tout statut) — miroir exact de getShopByDomain/getGdprShopByDomain
// (identiques en substance, seule leur gestion d'erreur différait à l'appelant). Utilisée pour
// app/uninstalled et les 3 topics GDPR : ces topics doivent trouver la boutique quel que soit son
// statut (une boutique déjà 'uninstalled' doit pouvoir recevoir un second app/uninstalled sans
// erreur ; une demande GDPR reste légale même boutique désinstallée).
export async function resolveShopLenient(
  supabase: AdminClient,
  locator: WebhookShopLocator,
): Promise<WebhookShopRow | null> {
  const { data, error } = await applyLocator(
    supabase.from('shop').select('*'),
    locator,
  ).maybeSingle();

  if (error) {
    logWebhookError('[webhook-core] shop lookup failed (lenient)', {
      code: error.code,
      message: error.message,
      locator,
    });
    return null;
  }
  return data as WebhookShopRow | null;
}

// Résolution ACTIVE UNIQUEMENT — miroir exact de getActiveShopByDomain / du select inline de
// handleBulkFinishWebhook (status='active' aux deux). Utilisée pour orders/*, products/*,
// refunds/create, bulk_operations/finish.
export async function resolveShopActive(
  supabase: AdminClient,
  locator: WebhookShopLocator,
): Promise<WebhookShopRow | null> {
  const { data, error } = await applyLocator(
    supabase.from('shop').select('*').eq('status', 'active'),
    locator,
  ).maybeSingle();

  if (error) {
    logWebhookError('[webhook-core] shop lookup failed (active)', {
      code: error.code,
      message: error.message,
      locator,
    });
    return null;
  }
  return data as WebhookShopRow | null;
}

const LENIENT_TOPICS = new Set([
  'app/uninstalled',
  'customers/data_request',
  'customers/redact',
  'shop/redact',
]);

// Classification PARTAGÉE topic -> tolérance de statut — la même liste, quelle que soit
// l'origine de l'appel. Ne PAS dupliquer cette liste ailleurs.
export function shopToleranceForTopic(topic: string): 'lenient' | 'active' {
  return LENIENT_TOPICS.has(topic) ? 'lenient' : 'active';
}

// Point d'entrée UNIQUE de résolution boutique par topic — les deux endpoints l'appellent avec
// LEUR PROPRE locator (domaine pour legacy, id pour l'opaque), jamais une résolution dupliquée.
export async function resolveShopForTopic(
  supabase: AdminClient,
  topic: string,
  locator: WebhookShopLocator | null,
): Promise<WebhookShopRow | null> {
  if (!locator) {
    return null;
  }
  return shopToleranceForTopic(topic) === 'lenient'
    ? resolveShopLenient(supabase, locator)
    : resolveShopActive(supabase, locator);
}

// ── Mapping du payload REST Shopify (partagé — le corps est identique quelle que soit l'URL de
// livraison, seule la résolution d'identité diffère entre les deux endpoints) ─────────────────
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
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

function mapWebhookCustomAttributes(value: unknown): ShopifyCustomAttribute[] | null {
  if (!Array.isArray(value)) return null;
  const attributes: ShopifyCustomAttribute[] = [];
  for (const entry of value) {
    if (isRecord(entry)) {
      const key = stringField(entry, 'name');
      if (key) attributes.push({ key, value: stringField(entry, 'value') });
    }
  }
  return attributes;
}

function mapWebhookAddress(rec: Record<string, unknown> | null): ShopifyAddress | null {
  if (!rec) return null;
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

export function mapOrderWebhookToOrderNode(payload: unknown): ShopifyOrderNode | null {
  if (!isRecord(payload)) return null;
  const orderId = stringField(payload, 'id');
  if (!orderId) return null;

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
          originalUnitPriceSet: { shopMoney: { amount: stringField(lineItem, 'price') ?? '0' } },
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

export function mapProductWebhookToProductNode(payload: unknown): ShopifyProductNode | null {
  if (!isRecord(payload)) return null;
  const productId = stringField(payload, 'id');
  const title = stringField(payload, 'title');
  const variants = Array.isArray(payload.variants) ? payload.variants : [];
  if (!productId || !title) return null;

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

export function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

// ── Classification d'erreur (partagée) ──────────────────────────────────────────────────────
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
  'shopify_refund_receipt_failed',
  'shopify_pcd_audit_failed',
  'shopify_uninstall_shop_domain_missing',
  'shopify_uninstall_shop_domain_mismatch',
]);

export function sanitizeWebhookError(error: unknown): string {
  const raw = error instanceof Error ? error.message : '';
  return CONTROLLED_WEBHOOK_ERROR_CODES.has(raw) ? raw : 'internal_processing_error';
}

export function isTerminalWebhookError(error: unknown): boolean {
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

// ── Double écriture L2 — best-effort, ne fait jamais échouer le chemin appelant ────────────────
async function runDualWrite(label: string, work: () => Promise<void>) {
  try {
    await work();
  } catch (error) {
    logWebhookError(`[webhook-core] dual-write failed (${label})`, {
      message: error instanceof Error ? error.message : String(error),
    });
    Sentry.captureException(error, {
      tags: { module: 'shopify.webhook-core', dualWriteLabel: label },
    });
  }
}

// ── webhook_event : réception + cycle d'états (LA clé d'idempotence par livraison) ────────────
export type WebhookReceipt = {
  duplicate: boolean;
  eventId: string | null;
  status: string | null;
  payload: Json | null;
  nextAttemptAt: string | null;
  error: boolean;
};

// Idempotence : insert dédup par shopify_webhook_id (contrainte unique). Un conflit retrouve
// l'état durable : done/terminal sont ignorés par l'appelant, retryable est réclamé à nouveau
// après son échéance (isReceiptDue ci-dessous).
export async function recordWebhookReceipt({
  supabase,
  webhookId,
  topic,
  shopDomain,
  shopId,
  merchantAccountId,
  triggeredAt,
  payload,
}: {
  supabase: AdminClient;
  webhookId: string;
  topic: string;
  shopDomain: string | null;
  shopId: string | null;
  merchantAccountId: string | null;
  triggeredAt: string | null;
  payload: Json;
}): Promise<WebhookReceipt> {
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
        logWebhookError('[webhook-core] duplicate lookup failed', { topic, webhookId });
        return {
          duplicate: true,
          eventId: null,
          status: null,
          payload: null,
          nextAttemptAt: null,
          error: true,
        };
      }
      logWebhookInfo('[webhook-core] duplicate received', {
        topic,
        webhookId,
        status: existing.status,
      });
      return {
        duplicate: true,
        eventId: existing.id,
        status: existing.status,
        payload: existing.payload,
        nextAttemptAt: existing.next_attempt_at,
        error: false,
      };
    }

    logWebhookError('[webhook-core] dedup insert failed', {
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

// Un doublon retryable dont l'échéance est passée doit être retraité — jamais un autre.
export function isReceiptDue(receipt: WebhookReceipt): boolean {
  return (
    receipt.status === 'retryable' &&
    (receipt.nextAttemptAt === null || Date.parse(receipt.nextAttemptAt) <= Date.now())
  );
}

export async function finishWebhookStatus({
  supabase,
  eventId,
  outcome,
  errorCode,
  proof,
}: {
  supabase: AdminClient;
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
    logWebhookError('[webhook-core] durable status update failed', {
      eventId,
      outcome,
      code: error?.code ?? 'not_claimed',
    });
  }
}

// ── Traitement par topic — chacun reçoit `shop` déjà résolu, ne fait plus AUCUNE résolution
// d'identité (ni domaine, ni jeton). Remplace les anciens handle*Webhook de route.ts. ──────────

async function processOrderCore({
  supabase,
  shop,
  topic,
  payload,
  webhookId,
  triggeredAt,
}: {
  supabase: AdminClient;
  shop: WebhookShopRow;
  topic: string;
  payload: unknown;
  webhookId: string | null;
  triggeredAt: string | null;
}) {
  const orderNode = mapOrderWebhookToOrderNode(payload);
  if (!orderNode) {
    logWebhookError('[webhook-core] invalid order payload', {
      topic,
      shopDomain: shop.shop_domain,
    });
    return;
  }

  const result = await persistShopifyOrder({
    merchantAccountId: shop.merchant_account_id,
    orderNode,
    shopId: shop.id,
    supabaseServiceClient: supabase,
  });

  if (result.ok) {
    logWebhookInfo('[webhook-core] order persisted', {
      orderId: orderNode.id,
      topic,
      shopDomain: shop.shop_domain,
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
    logWebhookError('[webhook-core] order persist failed', {
      errorCode: sanitizeWebhookError(result.error),
      orderId: orderNode.id,
      topic,
      shopDomain: shop.shop_domain,
    });
    throw new Error('shopify_order_persist_failed');
  }
}

async function processProductCore({
  supabase,
  shop,
  topic,
  payload,
  webhookId,
  triggeredAt,
}: {
  supabase: AdminClient;
  shop: WebhookShopRow;
  topic: string;
  payload: unknown;
  webhookId: string | null;
  triggeredAt: string | null;
}) {
  const productNode = mapProductWebhookToProductNode(payload);
  if (!productNode) {
    logWebhookError('[webhook-core] invalid product payload', {
      topic,
      shopDomain: shop.shop_domain,
    });
    return;
  }

  const result = await persistShopifyProductWebhook({
    merchantAccountId: shop.merchant_account_id,
    productNode,
    shopId: shop.id,
    supabaseServiceClient: supabase,
  });

  if (result.ok) {
    logWebhookInfo('[webhook-core] product persisted', {
      productId: productNode.id,
      topic,
      shopDomain: shop.shop_domain,
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
    logWebhookError('[webhook-core] product persist failed', {
      errorCode: sanitizeWebhookError(result.error),
      productId: productNode.id,
      topic,
      shopDomain: shop.shop_domain,
    });
    throw new Error('shopify_product_persist_failed');
  }
}

// app/uninstalled : marque UNIQUEMENT cette boutique + révoque ses tokens (le refresh + les
// expirations) → sa sync s'arrête (les selects filtrent status='active'). Défense en profondeur :
// id + merchant_account_id + shop_domain, jamais une seule colonne.
async function processAppUninstalledCore({
  supabase,
  shop,
}: {
  supabase: AdminClient;
  shop: WebhookShopRow;
}) {
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
    .eq('shop_domain', shop.shop_domain);

  if (updateError) {
    logWebhookError('[webhook-core] app/uninstalled update failed', {
      code: updateError.code,
      details: updateError.details,
      hint: updateError.hint,
      message: updateError.message,
      shopDomain: shop.shop_domain,
    });
    return;
  }

  await runDualWrite('app_uninstalled_connection_status', async () => {
    await supabase
      .from('store_connection')
      .update({ status: 'uninstalled', uninstalled_at: new Date().toISOString() })
      .eq('platform', 'shopify')
      .eq('external_identifier', shop.shop_domain);
  });

  const { error: auditError } = await supabase.from('audit_log').insert({
    merchant_account_id: shop.merchant_account_id,
    actor_user_id: null,
    action: 'shopify.app_uninstalled',
    resource_type: 'shop',
    resource_id: shop.id,
    payload: { shopDomain: shop.shop_domain },
  });

  if (auditError) {
    logWebhookError('[webhook-core] app/uninstalled audit failed', {
      code: auditError.code,
      details: auditError.details,
      hint: auditError.hint,
      message: auditError.message,
      shopDomain: shop.shop_domain,
    });
    return;
  }

  logWebhookInfo('[webhook-core] app/uninstalled processed', { shopDomain: shop.shop_domain });
}

async function processRefundCore({
  supabase,
  shop,
  topic,
  payload,
  webhookId,
  triggeredAt,
}: {
  supabase: AdminClient;
  shop: WebhookShopRow;
  topic: string;
  payload: unknown;
  webhookId: string | null;
  triggeredAt: string | null;
}) {
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
      logWebhookError('[webhook-core] refund order lookup failed', {
        errorCode: sanitizeWebhookError(orderLookupError.message),
        orderId: refund.orderId,
        shopDomain: shop.shop_domain,
      });
      throw new Error('shopify_refund_order_lookup_failed');
    }
    localOrderId = localOrder?.id ?? null;
  }

  const auditPayload = toJson({
    cashStillHeldByTeer: refund.cashStillHeldByTeer,
    localOrderId,
    nonCashRefundedMinor: refund.nonCashRefundedMinor,
    orderId: refund.orderId,
    shopDomain: shop.shop_domain,
    shouldUpdateFinancialStatus: refund.shouldUpdateFinancialStatus,
    successfulRefundCount: refund.successfulRefundCount,
    transactionSummary: refund.transactionSummary,
  });
  const resourceType = localOrderId ? 'orders' : 'shop';
  const resourceId = localOrderId ?? shop.id;

  // Idempotence métier (migration 0144) : store_connection_id + externalRefundId, jamais
  // delivery_id (deux delivery_id distincts pour le MÊME remboursement ne doivent produire
  // qu'une seule écriture — le scénario exact d'une bascule d'abonnement mal séquencée).
  const connection = await resolveShopConnection(supabase, shop);

  if (connection && refund.externalRefundId) {
    const { data: recorded, error: rpcError } = await supabase.rpc(
      'record_shopify_refund_receipt',
      {
        p_store_connection_id: connection.storeConnectionId,
        p_external_id: refund.externalRefundId,
        p_local_order_id: nullableRpcArg(localOrderId),
        p_should_update_financial_status: refund.shouldUpdateFinancialStatus,
        p_merchant_account_id: shop.merchant_account_id,
        p_actor_user_id: nullableRpcArg<string>(null),
        p_resource_type: resourceType,
        p_resource_id: resourceId,
        p_audit_payload: auditPayload,
      },
    );

    if (rpcError) {
      logWebhookError('[webhook-core] refund receipt rpc failed', {
        errorCode: sanitizeWebhookError(rpcError.message),
        localOrderId,
        orderId: refund.orderId,
        shopDomain: shop.shop_domain,
      });
      throw new Error('shopify_refund_receipt_failed');
    }

    if (recorded === false) {
      logWebhookInfo('[webhook-core] refund already recorded, skipping duplicate write', {
        externalRefundId: refund.externalRefundId,
        storeConnectionId: connection.storeConnectionId,
        topic,
      });
    }
  } else {
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
        logWebhookError('[webhook-core] refund order update failed', {
          errorCode: sanitizeWebhookError(orderUpdateError.message),
          localOrderId,
          orderId: refund.orderId,
          shopDomain: shop.shop_domain,
        });
        throw new Error('shopify_refund_order_update_failed');
      }
    }

    const { error: refundAuditError } = await supabase.from('audit_log').insert({
      merchant_account_id: shop.merchant_account_id,
      actor_user_id: null,
      action: 'shopify.refund_received',
      resource_type: resourceType,
      resource_id: resourceId,
      payload: auditPayload,
    });
    if (refundAuditError) {
      throw new Error('shopify_refund_audit_failed');
    }
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

async function processBulkFinishCore({
  supabase,
  shop,
  topic,
  webhookId,
  triggeredAt,
}: {
  supabase: AdminClient;
  shop: WebhookShopRow;
  topic: string;
  webhookId: string | null;
  triggeredAt: string | null;
}) {
  const app = getShopifyAppForShop(shop.shopify_client_id);
  if (!app) {
    logWebhookError('[webhook-core] bulk finish missing Shopify credentials', { topic });
    return;
  }

  const result = await processFinishedBulkForShop(supabase, shop, app.clientId, app.clientSecret);
  logWebhookInfo('[webhook-core] bulk finish processed', {
    shopDomain: shop.shop_domain,
    ok: result.ok,
  });

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

// ── GDPR — jamais souscriptible via l'Admin API (n'atteint donc jamais l'endpoint opaque), mais
// regroupé ici pour rester dans le même dispatcher que le reste (une seule fonction de bascule
// success/failure/finishWebhookStatus, jamais deux). ────────────────────────────────────────────
export type GdprProcessResult = {
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

async function processGdprCore({
  eventId,
  payload,
  shop,
  supabase,
  topic,
}: {
  eventId: string;
  payload: unknown;
  shop: WebhookShopRow;
  supabase: AdminClient;
  topic: string;
}): Promise<GdprProcessResult> {
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
      if (!shopifyCustomerId) throw new Error('gdpr_customer_id_missing');
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
      if (!shopifyCustomerId) throw new Error('gdpr_customer_id_missing');
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
    payload: toGdprAuditPayload({ topic, status: 'done', artifactId, artifactExpiresAt, proof }),
  });

  if (error) throw new Error('gdpr_audit_failed');

  return { proof, artifactId, artifactExpiresAt };
}

// ── Dispatcher partagé — reçoit `shop` déjà résolu (jamais un domaine/jeton). Équivalent de
// l'ancien processWebhook(), sans la résolution d'identité (déplacée chez l'appelant). ─────────
const PCD_TOPICS = new Set([
  'orders/create',
  'orders/updated',
  'orders/cancelled',
  'orders/fulfilled',
  'bulk_operations/finish',
  'customers/data_request',
  'customers/redact',
  'shop/redact',
]);

export async function dispatchWebhookCore({
  supabase,
  shop,
  eventId,
  topic,
  payload,
  webhookId,
  triggeredAt,
}: {
  supabase: AdminClient;
  shop: WebhookShopRow | null;
  eventId: string;
  topic: string;
  payload: unknown;
  webhookId: string | null;
  triggeredAt: string | null;
}): Promise<GdprProcessResult | null> {
  // Pré-audit PCD : `shop` est déjà résolu (avec la bonne tolérance topic-par-topic) au moment où
  // ce dispatcher est appelé — l'audit ne peut donc jamais précéder le refus qui aurait dû avoir
  // lieu (incident cross-tenant 2026-08-23, corrigé en amont ici par construction, pas par un
  // ordre d'instructions à préserver manuellement).
  if (PCD_TOPICS.has(topic) && shop) {
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

  switch (topic) {
    case 'orders/create':
    case 'orders/updated':
    case 'orders/cancelled':
    case 'orders/fulfilled':
      if (!shop) {
        logWebhookInfo('[webhook-core] no active shop for order webhook', { topic });
        return null;
      }
      await processOrderCore({ supabase, shop, topic, payload, webhookId, triggeredAt });
      return null;
    case 'refunds/create':
      if (!shop) {
        logWebhookInfo('[webhook-core] no active shop for refund webhook', { topic });
        return null;
      }
      await processRefundCore({ supabase, shop, topic, payload, webhookId, triggeredAt });
      return null;
    case 'bulk_operations/finish':
      if (!shop) {
        logWebhookInfo('[webhook-core] no active shop for bulk finish', { topic });
        return null;
      }
      await processBulkFinishCore({ supabase, shop, topic, webhookId, triggeredAt });
      return null;
    case 'products/create':
    case 'products/update':
      if (!shop) {
        logWebhookInfo('[webhook-core] no active shop for product webhook', { topic });
        return null;
      }
      await processProductCore({ supabase, shop, topic, payload, webhookId, triggeredAt });
      return null;
    case 'app/uninstalled':
      if (!shop) {
        logWebhookInfo('[webhook-core] app/uninstalled shop not found', {});
        return null;
      }
      await processAppUninstalledCore({ supabase, shop });
      return null;
    case 'customers/data_request':
    case 'customers/redact':
    case 'shop/redact':
      if (!shop) throw new Error('gdpr_shop_not_found');
      return processGdprCore({ eventId, payload, shop, supabase, topic });
    default:
      logWebhookInfo('[webhook-core] unhandled topic', topic);
      return null;
  }
}

// ── Orchestration success/failure — try/catch + finishWebhookStatus, partagée ─────────────────
export async function runResolvedWebhookEvent({
  supabase,
  eventId,
  shop,
  topic,
  payload,
  webhookId,
  triggeredAt,
}: {
  supabase: AdminClient;
  eventId: string;
  shop: WebhookShopRow | null;
  topic: string;
  payload: unknown;
  webhookId: string | null;
  triggeredAt: string | null;
}): Promise<void> {
  try {
    const result = await dispatchWebhookCore({
      supabase,
      shop,
      eventId,
      topic,
      payload,
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
    logWebhookError('[webhook-core] processing failed', { eventId, topic, outcome, errorCode });
    await finishWebhookStatus({ supabase, eventId, outcome, errorCode });
  }
}
