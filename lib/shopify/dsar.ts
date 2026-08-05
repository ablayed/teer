import type { CustomerDataExport } from '@/lib/shopify/gdpr';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';

export const SHOPIFY_DSAR_BUCKET = 'shopify-dsar';
export const DSAR_MAX_TTL_SECONDS = 24 * 60 * 60;

type AdminClient = SupabaseClient<Database>;

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

  return {
    artifactId: artifact.id,
    expiresAt: artifact.expires_at,
    byteSize: body.byteLength,
  };
}

export async function createPrivateDsarSignedUrl(
  admin: AdminClient,
  {
    artifactId,
    merchantAccountId,
    now = new Date(),
  }: {
    artifactId: string;
    merchantAccountId: string;
    now?: Date;
  },
): Promise<{ url: string; expiresAt: string }> {
  const { data: artifact, error } = await admin
    .from('shopify_dsar_artifact')
    .select('storage_bucket, storage_path, status, expires_at')
    .eq('id', artifactId)
    .eq('merchant_account_id', merchantAccountId)
    .eq('status', 'ready')
    .maybeSingle();
  assertResult({ error }, 'dsar_artifact_lookup');

  if (!artifact) {
    throw new Error('dsar_artifact_not_found');
  }

  const expiresAtMs = Date.parse(artifact.expires_at);
  const remainingSeconds = Math.floor((expiresAtMs - now.getTime()) / 1_000);
  const expiresIn = Math.min(DSAR_MAX_TTL_SECONDS, remainingSeconds);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    const { error: expiryError } = await admin
      .from('shopify_dsar_artifact')
      .update({ status: 'expired' })
      .eq('id', artifactId)
      .eq('status', 'ready');
    assertResult({ error: expiryError }, 'dsar_artifact_expiry_finalize');
    throw new Error('dsar_artifact_expired');
  }

  const { data: signed, error: signedError } = await admin.storage
    .from(artifact.storage_bucket)
    .createSignedUrl(artifact.storage_path, expiresIn);
  if (signedError || !signed?.signedUrl) {
    throw new Error('dsar_signed_url_failed');
  }

  return { url: signed.signedUrl, expiresAt: artifact.expires_at };
}

export { createStorageAdminClient };
