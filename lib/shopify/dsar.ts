import { isProductionEnvironment } from '@/lib/security/environment-validation';
import {
  type PcdAccessAuditEntry,
  PcdAccessAuditError,
  writePcdAccessAudit,
} from '@/lib/security/pcd-access-audit';
import type { CustomerDataExport } from '@/lib/shopify/gdpr';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';

export const SHOPIFY_DSAR_BUCKET = 'shopify-dsar';
export const DSAR_MAX_TTL_SECONDS = 24 * 60 * 60;
export const DSAR_TEST_AUDIT_FAILURE_HEADER = 'x-teer-e2e-force-audit-failure';

type AdminClient = SupabaseClient<Database>;

export function isDsarAuditFailureTestHookEnabled(request: Request): boolean {
  // NODE_ENV vaut toujours 'production' sous `next start` (E2E_PROD_BUILD=1, cf. CLAUDE.md
  // "Validation finale E2E build-prod") : ce hook doit distinguer un vrai environnement de
  // production (VERCEL_ENV=production) d'un build de test qui tourne en mode prod par
  // construction. isProductionEnvironment() lit VERCEL_ENV en priorité pour ça.
  return (
    !isProductionEnvironment(process.env) &&
    process.env.E2E_TEST_MODE === '1' &&
    request.headers.get(DSAR_TEST_AUDIT_FAILURE_HEADER) === '1'
  );
}

export async function writePcdAccessAuditThroughDsarRoute(
  request: Request,
  client: AdminClient,
  entry: PcdAccessAuditEntry,
): Promise<string> {
  if (isDsarAuditFailureTestHookEnabled(request)) {
    throw new PcdAccessAuditError();
  }

  return writePcdAccessAudit(client, entry);
}

function createStorageAdminClient(): AdminClient {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('shopify_storage_admin_env_missing');
  }
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function assertResult<T extends { error: { message: string } | null }>(
  result: T,
  operation: string,
): asserts result is T & { error: null } {
  if (result.error) {
    throw new Error(`${operation}_failed`);
  }
}

export type DsarArtifactResult = {
  artifactId: string;
  expiresAt: string;
  byteSize: number;
};

export async function createPrivateDsarArtifact(
  admin: AdminClient,
  {
    eventId,
    merchantAccountId,
    shopId,
    data,
    now = new Date(),
  }: {
    eventId: string;
    merchantAccountId: string;
    shopId: string;
    data: CustomerDataExport;
    now?: Date;
  },
): Promise<DsarArtifactResult> {
  const expiresAt = new Date(now.getTime() + DSAR_MAX_TTL_SECONDS * 1_000).toISOString();
  const storagePath = `${merchantAccountId}/${eventId}.json`;
  const body = Buffer.from(JSON.stringify(data), 'utf8');

  const { data: artifact, error: insertError } = await admin
    .from('shopify_dsar_artifact')
    .upsert(
      {
        webhook_event_id: eventId,
        merchant_account_id: merchantAccountId,
        shop_id: shopId,
        storage_bucket: SHOPIFY_DSAR_BUCKET,
        storage_path: storagePath,
        status: 'pending',
        expires_at: expiresAt,
      },
      { onConflict: 'webhook_event_id' },
    )
    .select('id, expires_at')
    .single();
  assertResult({ error: insertError }, 'dsar_artifact_metadata');
  if (!artifact) {
    throw new Error('dsar_artifact_metadata_missing');
  }

  const { error: uploadError } = await admin.storage
    .from(SHOPIFY_DSAR_BUCKET)
    .upload(storagePath, body, {
      contentType: 'application/json',
      cacheControl: '0',
      upsert: true,
    });
  if (uploadError) {
    const { error: failureError } = await admin
      .from('shopify_dsar_artifact')
      .update({ status: 'failed' })
      .eq('id', artifact.id)
      .eq('status', 'pending');
    assertResult({ error: failureError }, 'dsar_artifact_failure_finalize');
    throw new Error('dsar_artifact_upload_failed');
  }

  const { error: readyError } = await admin
    .from('shopify_dsar_artifact')
    .update({
      status: 'ready',
      byte_size: body.byteLength,
      completed_at: now.toISOString(),
    })
    .eq('id', artifact.id)
    .eq('status', 'pending');
  assertResult({ error: readyError }, 'dsar_artifact_finalize');

  try {
    await writePcdAccessAudit(admin, {
      tenantId: merchantAccountId,
      shopId,
      actorKind: 'service',
      serviceKind: 'dsar_worker',
      action: 'generate_export',
      dataCategory: 'dsar_artifact',
      purpose: 'legal_request',
      outcome: 'succeeded',
      resourceType: 'dsar_artifact',
      resourceId: artifact.id,
      surface: 'dsar',
    });
  } catch {
    await admin.storage.from(SHOPIFY_DSAR_BUCKET).remove([storagePath]);
    const { error: auditFailureError } = await admin
      .from('shopify_dsar_artifact')
      .update({ status: 'failed' })
      .eq('id', artifact.id)
      .eq('status', 'ready');
    assertResult({ error: auditFailureError }, 'dsar_audit_failure_finalize');
    throw new Error('dsar_audit_unavailable');
  }

  return {
    artifactId: artifact.id,
    expiresAt: artifact.expires_at,
    byteSize: body.byteLength,
  };
}

export async function issuePrivateDsarDownloadAuthorization(
  client: AdminClient,
  {
    artifactId,
    merchantAccountId,
    shopId,
  }: {
    artifactId: string;
    merchantAccountId: string;
    shopId: string;
  },
): Promise<{ downloadToken: string; expiresAt: string }> {
  const { data, error } = await client.rpc('issue_shopify_dsar_download_authorization', {
    p_artifact_id: artifactId,
    p_shop_id: shopId,
    p_tenant_id: merchantAccountId,
  });
  const row = Array.isArray(data) ? data[0] : null;
  if (error || !row) {
    throw new Error('dsar_download_authorization_failed');
  }

  return { downloadToken: row.download_token, expiresAt: row.expires_at };
}

export async function consumePrivateDsarDownloadAuthorization(
  client: AdminClient,
  {
    artifactId,
    downloadToken,
    merchantAccountId,
    shopId,
  }: {
    artifactId: string;
    downloadToken: string;
    merchantAccountId: string;
    shopId: string;
  },
): Promise<{ authorizationId: string; bucket: string; path: string; byteSize: number }> {
  const { data, error } = await client.rpc('consume_shopify_dsar_download_authorization', {
    p_artifact_id: artifactId,
    p_download_token: downloadToken,
    p_shop_id: shopId,
    p_tenant_id: merchantAccountId,
  });
  const row = Array.isArray(data) ? data[0] : null;
  if (error || !row) {
    throw new Error('dsar_download_authorization_forbidden');
  }

  return {
    authorizationId: row.authorization_id,
    bucket: row.storage_bucket,
    path: row.storage_path,
    byteSize: row.byte_size,
  };
}

export async function downloadPrivateDsarArtifactAtPath(
  admin: AdminClient,
  { bucket, path }: { bucket: string; path: string },
): Promise<Blob> {
  const { data, error } = await admin.storage.from(bucket).download(path);
  if (error || !data) {
    throw new Error('dsar_artifact_download_failed');
  }
  return data;
}

export { createStorageAdminClient };
