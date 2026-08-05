import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient, User } from '@supabase/supabase-js';

export const PCD_RECENT_AUTH_MAX_AGE_SECONDS = 15 * 60;
export const PCD_EXPORT_MAX_ROWS = 500;
export const PCD_EXPORT_MAX_BYTES = 5 * 1024 * 1024;

export class PcdAccessControlError extends Error {
  readonly code:
    | 'audit_unavailable'
    | 'quota_exceeded'
    | 'quota_unavailable'
    | 'recent_authentication_required';

  constructor(
    code:
      | 'audit_unavailable'
      | 'quota_exceeded'
      | 'quota_unavailable'
      | 'recent_authentication_required',
  ) {
    super(code);
    this.name = 'PcdAccessControlError';
    this.code = code;
  }
}

type ServerClient = SupabaseClient<Database>;

export type PcdQuotaAction =
  | 'search'
  | 'generate_export'
  | 'download_export'
  | 'generate_download_authorization'
  | 'external_share';

export async function consumePcdQuota(
  client: ServerClient,
  input: {
    tenantId: string;
    shopId?: string | null;
    actorKind: 'human' | 'service';
    serviceKind?: 'webhook' | 'cron' | 'worker' | 'service_role' | 'shopify_sync' | 'dsar_worker';
    action: PcdQuotaAction;
  },
): Promise<{ currentCount: number; maxCount: number; windowStart: string }> {
  const { data, error } = await client.rpc('consume_pcd_access_quota', {
    p_action: input.action,
    p_actor_kind: input.actorKind,
    p_service_kind: input.serviceKind ?? null,
    p_shop_id: input.shopId ?? null,
    p_tenant_id: input.tenantId,
  });

  const row = Array.isArray(data) ? data[0] : null;
  if (error || !row) {
    throw new PcdAccessControlError('quota_unavailable');
  }

  if (!row.allowed) {
    throw new PcdAccessControlError('quota_exceeded');
  }

  return {
    currentCount: row.current_count,
    maxCount: row.max_count,
    windowStart: row.window_start,
  };
}

export function isRecentAuthentication(
  user: Pick<User, 'last_sign_in_at'>,
  now = new Date(),
): boolean {
  if (!user.last_sign_in_at) {
    return false;
  }

  const lastSignIn = Date.parse(user.last_sign_in_at);
  return (
    Number.isFinite(lastSignIn) &&
    lastSignIn <= now.getTime() &&
    now.getTime() - lastSignIn <= PCD_RECENT_AUTH_MAX_AGE_SECONDS * 1_000
  );
}

export async function requireRecentAuthentication(
  client: ServerClient,
  now = new Date(),
): Promise<User> {
  const {
    data: { user },
    error,
  } = await client.auth.getUser();

  if (error || !user || !isRecentAuthentication(user, now)) {
    throw new PcdAccessControlError('recent_authentication_required');
  }

  return user;
}

export function assertPcdExportBounds(rowCount: number, byteLength?: number): void {
  if (!Number.isSafeInteger(rowCount) || rowCount < 0 || rowCount > PCD_EXPORT_MAX_ROWS) {
    throw new PcdAccessControlError('quota_exceeded');
  }

  if (
    byteLength !== undefined &&
    (!Number.isSafeInteger(byteLength) || byteLength > PCD_EXPORT_MAX_BYTES)
  ) {
    throw new PcdAccessControlError('quota_exceeded');
  }
}
