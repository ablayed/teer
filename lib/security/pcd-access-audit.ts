import type { Database, Json } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

// Server-only module by import boundary: this file is imported only by server
// actions, route handlers and server-side Shopify/IA code.
export const PCD_ACCESS_ACTIONS = [
  'view_detail',
  'search',
  'list_access',
  'generate_export',
  'download_export',
  'generate_signed_url',
  'generate_download_authorization',
  'external_share',
  'privileged_read',
  'ai_processing',
  'support_submission',
] as const;

export const PCD_ACCESS_CATEGORIES = [
  'customer_identity',
  'customer_contact',
  'delivery_address',
  'shopify_payload',
  'dsar_artifact',
  'member_data',
  'merchant_data',
] as const;

export const PCD_ACCESS_PURPOSES = [
  'order_fulfillment',
  'customer_support',
  'delivery_execution',
  'cash_reconciliation',
  'fraud_review',
  'legal_request',
  'external_share',
  'system_processing',
] as const;

export const PCD_ACCESS_OUTCOMES = ['allowed', 'denied', 'succeeded', 'failed'] as const;

export const PCD_ACCESS_ACTOR_KINDS = ['human', 'service'] as const;
export const PCD_ACCESS_SERVICE_KINDS = [
  'webhook',
  'cron',
  'worker',
  'service_role',
  'shopify_sync',
  'dsar_worker',
] as const;

export const PCD_ACCESS_SURFACES = [
  'server_component',
  'server_action',
  'route_handler',
  'rpc',
  'assistant',
  'dsar',
  'whatsapp',
  'feedback',
  'shopify',
  'worker',
  'sentry',
  'posthog',
  'resend',
  'groq',
] as const;

export const PCD_ACCESS_RESOURCE_TYPES = [
  'order',
  'customer',
  'driver',
  'member',
  'delivery_address',
  'dsar_artifact',
  'export',
  'assistant',
  'feedback',
  'shopify_payload',
  'support_submission',
  'whatsapp_share',
] as const;

export type PcdAccessAction = (typeof PCD_ACCESS_ACTIONS)[number];
export type PcdAccessCategory = (typeof PCD_ACCESS_CATEGORIES)[number];
export type PcdAccessPurpose = (typeof PCD_ACCESS_PURPOSES)[number];
export type PcdAccessOutcome = (typeof PCD_ACCESS_OUTCOMES)[number];
export type PcdAccessActorKind = (typeof PCD_ACCESS_ACTOR_KINDS)[number];
export type PcdAccessServiceKind = (typeof PCD_ACCESS_SERVICE_KINDS)[number];
export type PcdAccessSurface = (typeof PCD_ACCESS_SURFACES)[number];
export type PcdAccessResourceType = (typeof PCD_ACCESS_RESOURCE_TYPES)[number];

type AuditMetadataValue = string | number | boolean;
export type PcdAccessMetadata = Record<string, AuditMetadataValue>;

export type PcdAccessAuditEntry = {
  tenantId: string;
  shopId?: string | null;
  actorKind: PcdAccessActorKind;
  serviceKind?: PcdAccessServiceKind | null;
  action: PcdAccessAction;
  dataCategory: PcdAccessCategory;
  purpose: PcdAccessPurpose;
  outcome: PcdAccessOutcome;
  resourceType: PcdAccessResourceType;
  resourceId?: string | null;
  surface: PcdAccessSurface;
  metadata?: PcdAccessMetadata;
  idempotencyKey?: string | null;
};

export class PcdAccessAuditError extends Error {
  constructor() {
    super('pcd_access_audit_write_failed');
    this.name = 'PcdAccessAuditError';
  }
}

export function sanitizePcdIdempotencyKey(value: string | null | undefined): string | null {
  if (!value || value.length > 96 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    return null;
  }
  return value;
}

const ALLOWED_METADATA_KEYS = new Set([
  'channel',
  'duration_ms',
  'error_code',
  'http_status',
  'latency_ms',
  'provider',
  'reason_code',
  'result_count',
  'source',
  'page_number',
  'page_size',
  'quota_count',
  'quota_limit',
]);

const FORBIDDEN_METADATA_KEYS = new Set([
  'address',
  'args',
  'body',
  'exception',
  'message',
  'name',
  'payload',
  'phone',
  'query',
  'token',
  'url',
]);

const SENSITIVE_VALUE_PATTERNS = [
  /https?:\/\//i,
  /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/i,
  /(?:\+?\d[\s().-]?){8,}/,
  /^(?:bearer|basic)[ \t]+/i,
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
  /^[A-Za-z-]{2,32}:[^:]+$/,
];
const TECHNICAL_CODE_PATTERN = /^[A-Za-z0-9._:-]+$/;

export function sanitizePcdAccessMetadata(metadata: PcdAccessMetadata = {}): Json {
  const keys = Object.keys(metadata);
  if (keys.length > 8) {
    throw new PcdAccessAuditError();
  }

  const result: Record<string, Json> = {};
  for (const key of keys) {
    if (!ALLOWED_METADATA_KEYS.has(key) || FORBIDDEN_METADATA_KEYS.has(key)) {
      throw new PcdAccessAuditError();
    }

    const value = metadata[key];
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new PcdAccessAuditError();
    }

    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0 || value > 5000)) {
      throw new PcdAccessAuditError();
    }

    if (typeof value === 'string') {
      if (
        value.length > 128 ||
        !TECHNICAL_CODE_PATTERN.test(value) ||
        SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value))
      ) {
        throw new PcdAccessAuditError();
      }
    }

    result[key] = value;
  }

  const serialized = JSON.stringify(result);
  if (serialized.length > 2048) {
    throw new PcdAccessAuditError();
  }

  return result;
}

type TypedSupabaseClient = SupabaseClient<Database>;

/**
 * Server-only, fail-closed audit writer. The RPC derives a human actor from
 * auth.uid(); callers cannot supply actor_user_id. Service callers must use a
 * service-role client and explicitly declare serviceKind.
 */
export async function writePcdAccessAudit(
  client: TypedSupabaseClient,
  entry: PcdAccessAuditEntry,
): Promise<string> {
  const metadata = sanitizePcdAccessMetadata(entry.metadata);
  const { data, error } = await client.rpc('log_pcd_access_event', {
    p_action: entry.action,
    p_actor_kind: entry.actorKind,
    p_data_category: entry.dataCategory,
    p_metadata: metadata,
    p_outcome: entry.outcome,
    p_purpose: entry.purpose,
    p_resource_id: entry.resourceId ?? null,
    p_resource_type: entry.resourceType,
    p_service_kind: entry.serviceKind ?? null,
    p_shop_id: entry.shopId ?? null,
    p_surface: entry.surface,
    p_tenant_id: entry.tenantId,
    p_idempotency_key: entry.idempotencyKey ?? null,
  });

  if (error || typeof data !== 'string') {
    throw new PcdAccessAuditError();
  }

  return data;
}

export async function writePcdAccessAuditCategories(
  client: TypedSupabaseClient,
  entry: Omit<PcdAccessAuditEntry, 'dataCategory'>,
  categories: readonly PcdAccessCategory[],
): Promise<void> {
  for (const dataCategory of categories) {
    await writePcdAccessAudit(client, {
      ...entry,
      dataCategory,
      idempotencyKey: entry.idempotencyKey ? `${entry.idempotencyKey}:${dataCategory}` : null,
    });
  }
}
