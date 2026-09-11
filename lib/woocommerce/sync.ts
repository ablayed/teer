import { decryptConnectorCredential } from '@/lib/connector-credentials/crypto';
import { env } from '@/lib/env';
import type { PersistableCanonicalOrder } from '@/lib/ingestion/canonical';
import {
  type ResolvedWooCommerceConnection,
  resolveWooCommerceConnectionById,
} from '@/lib/ingestion/resolve-connection';
// R2.4 / commit 6 — synchronisation initiale WooCommerce bornée.
//
// La page est une position de lecture, jamais un curseur. Chaque reprise relit page=1 sur la
// fenêtre persistée et repasse par le même adaptateur et la même RPC que les webhooks.
import type { Tables } from '@/lib/supabase/database.types';
import type { Database } from '@/lib/supabase/database.types';
import { createProtectedSupabaseClient } from '@/lib/supabase/protected-client';
import { mapWooCommerceOrder } from '@/lib/woocommerce/adapter';
import { WooCommerceClient, WooCommerceClientError } from '@/lib/woocommerce/client';
import { persistWooCommerceCanonicalOrder } from '@/lib/woocommerce/ingestion';
import type { SupabaseClient } from '@supabase/supabase-js';

const SYNC_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;
const SYNC_ERROR_CODE = /^[a-z0-9_]{1,64}$/;

type AdminClient = SupabaseClient<Database>;
type SyncState = Tables<'store_connection_sync_state'>;
type Credential = Pick<
  Tables<'store_connection_credential'>,
  'scheme' | 'consumer_key_encrypted' | 'consumer_secret_encrypted'
>;

export type WooCommerceSyncErrorCode =
  | 'connection_not_found'
  | 'connection_inactive'
  | 'credentials_not_found'
  | 'credentials_invalid'
  | 'sync_already_running'
  | 'sync_already_completed'
  | 'sync_state_failed'
  | 'pagination_headers_invalid'
  | 'pagination_total_changed'
  | 'pagination_not_monotone'
  | 'pagination_resource_count_mismatch'
  | 'order_payload_invalid'
  | 'order_persist_failed'
  | 'sync_remote_failed';

export type WooCommerceSyncResult =
  | { readonly ok: true; readonly status: 'completed' | 'already_completed' }
  | { readonly ok: false; readonly errorCode: WooCommerceSyncErrorCode };

type SyncDependencies = {
  readonly admin?: AdminClient;
  readonly client?: WooCommerceClient;
  readonly now?: () => Date;
};

type PageTotals = {
  readonly total: number;
  readonly totalPages: number;
};

const syncLocks = new Map<string, Promise<WooCommerceSyncResult>>();

function createSupabaseAdminClient(): AdminClient {
  return createProtectedSupabaseClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

async function loadCredential(
  admin: AdminClient,
  connectionId: string,
): Promise<Credential | null> {
  const { data, error } = await admin
    .from('store_connection_credential')
    .select('scheme, consumer_key_encrypted, consumer_secret_encrypted')
    .eq('store_connection_id', connectionId)
    .is('revoked_at', null)
    .maybeSingle();
  return error || !data ? null : data;
}

async function loadSyncState(admin: AdminClient, connectionId: string): Promise<SyncState | null> {
  const { data, error } = await admin
    .from('store_connection_sync_state')
    .select('*')
    .eq('store_connection_id', connectionId)
    .maybeSingle();
  return error || !data ? null : data;
}

function truncateToSecond(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}

function initialWindow(now: Date): { readonly start: string; readonly end: string } {
  const end = truncateToSecond(now);
  return {
    start: new Date(end.getTime() - SYNC_WINDOW_MS).toISOString(),
    end: end.toISOString(),
  };
}

async function claimSyncState(
  admin: AdminClient,
  connection: ResolvedWooCommerceConnection,
  now: Date,
): Promise<
  | { readonly kind: 'claimed'; readonly state: SyncState }
  | { readonly kind: 'running' }
  | { readonly kind: 'completed' }
  | { readonly kind: 'failed' }
> {
  const existing = await loadSyncState(admin, connection.context.storeConnectionId);
  if (existing) {
    if (existing.status === 'completed') return { kind: 'completed' };
    if (existing.status === 'running') return { kind: 'running' };

    const { data, error } = await admin
      .from('store_connection_sync_state')
      .update({
        status: 'running',
        attempt: existing.attempt + 1,
        last_page_observed: 0,
        last_error_code: null,
        completed_at: null,
        updated_at: now.toISOString(),
      })
      .eq('id', existing.id)
      .in('status', ['pending', 'failed'])
      .select('*')
      .maybeSingle();
    if (data && !error) return { kind: 'claimed', state: data };

    const afterRace = await loadSyncState(admin, connection.context.storeConnectionId);
    if (afterRace?.status === 'running') return { kind: 'running' };
    if (afterRace?.status === 'completed') return { kind: 'completed' };
    return { kind: 'failed' };
  }

  const window = initialWindow(now);
  const { data, error } = await admin
    .from('store_connection_sync_state')
    .insert({
      store_connection_id: connection.context.storeConnectionId,
      merchant_account_id: connection.context.merchantAccountId,
      shop_id: connection.context.shopId,
      window_start: window.start,
      window_end: window.end,
      last_page_observed: 0,
      attempt: 1,
      status: 'running',
      last_error_code: null,
      updated_at: now.toISOString(),
      completed_at: null,
    })
    .select('*')
    .single();
  if (data && !error) return { kind: 'claimed', state: data };

  // The unique connection key serializes the first claim: the loser re-reads the winner's state.
  const afterInsertRace = await loadSyncState(admin, connection.context.storeConnectionId);
  if (afterInsertRace?.status === 'running') return { kind: 'running' };
  if (afterInsertRace?.status === 'completed') return { kind: 'completed' };
  return { kind: 'failed' };
}

function headerValue(
  headers: Headers | Record<string, string | string[] | undefined>,
  name: string,
) {
  if (headers instanceof Headers) return headers.get(name);
  const value = headers[name.toLowerCase()] ?? headers[name];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function nonNegativeInteger(value: string | null): number | null {
  return value && /^\d+$/.test(value) ? Number(value) : null;
}

function readPageTotals(
  headers: Headers | Record<string, string | string[] | undefined>,
): PageTotals | null {
  const total = nonNegativeInteger(headerValue(headers, 'x-wp-total'));
  const totalPages = nonNegativeInteger(headerValue(headers, 'x-wp-totalpages'));
  return total !== null &&
    totalPages !== null &&
    Number.isSafeInteger(total) &&
    Number.isSafeInteger(totalPages)
    ? { total, totalPages }
    : null;
}

function pagePath(state: SyncState, page: number): string {
  const params = new URLSearchParams({
    after: new Date(Date.parse(state.window_start) - 1000).toISOString(),
    before: state.window_end,
    dates_are_gmt: 'true',
    page: String(page),
    per_page: String(PAGE_SIZE),
    orderby: 'date',
    order: 'asc',
  });
  return `wp-json/wc/v3/orders?${params.toString()}`;
}

function compareNumericIds(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareOrderPosition(
  left: { readonly createdAt: string | null; readonly externalOrderId: string },
  right: { readonly createdAt: string | null; readonly externalOrderId: string },
): number | null {
  if (!left.createdAt || !right.createdAt) return null;
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return null;
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
  return compareNumericIds(left.externalOrderId, right.externalOrderId);
}

function insideWindow(createdAt: string | null, state: SyncState): boolean {
  if (!createdAt) return false;
  const timestamp = Date.parse(createdAt);
  return (
    Number.isFinite(timestamp) &&
    timestamp >= Date.parse(state.window_start) &&
    timestamp < Date.parse(state.window_end)
  );
}

async function updateSyncState(
  admin: AdminClient,
  state: SyncState,
  payload: Partial<
    Pick<
      SyncState,
      'last_page_observed' | 'last_error_code' | 'status' | 'updated_at' | 'completed_at'
    >
  >,
): Promise<boolean> {
  const { error } = await admin
    .from('store_connection_sync_state')
    .update(payload)
    .eq('id', state.id);
  return !error;
}

async function markFailed(
  admin: AdminClient,
  state: SyncState,
  errorCode: WooCommerceSyncErrorCode,
) {
  const safeCode = SYNC_ERROR_CODE.test(errorCode) ? errorCode : 'sync_state_failed';
  await updateSyncState(admin, state, {
    status: 'failed',
    last_error_code: safeCode,
    updated_at: new Date().toISOString(),
  });
}

function isCredentialInvalid(error: unknown): boolean {
  return (
    error instanceof WooCommerceClientError &&
    (error.code === 'credentials_invalid' || error.code === 'woocommerce_authentication_error')
  );
}

async function runSync(
  connectionId: string,
  dependencies: SyncDependencies,
): Promise<WooCommerceSyncResult> {
  const admin = dependencies.admin ?? createSupabaseAdminClient();
  const connectionResult = await resolveWooCommerceConnectionById(admin, connectionId);
  if (!connectionResult.ok) {
    return {
      ok: false,
      errorCode:
        connectionResult.reason === 'connection_inactive'
          ? 'connection_inactive'
          : 'connection_not_found',
    };
  }

  const credential = await loadCredential(admin, connectionId);
  if (
    !credential ||
    credential.scheme !== 'basic_consumer' ||
    !credential.consumer_key_encrypted ||
    !credential.consumer_secret_encrypted
  ) {
    return { ok: false, errorCode: 'credentials_not_found' };
  }

  let client = dependencies.client;
  let claimedState: SyncState | null = null;
  try {
    if (!client) {
      client = new WooCommerceClient({
        baseUrl: connectionResult.connection.externalIdentifier,
        consumerKey: decryptConnectorCredential(credential.consumer_key_encrypted),
        consumerSecret: decryptConnectorCredential(credential.consumer_secret_encrypted),
      });
    }

    const claim = await claimSyncState(
      admin,
      connectionResult.connection,
      dependencies.now?.() ?? new Date(),
    );
    if (claim.kind === 'running') return { ok: false, errorCode: 'sync_already_running' };
    if (claim.kind === 'completed') return { ok: true, status: 'already_completed' };
    if (claim.kind === 'failed') return { ok: false, errorCode: 'sync_state_failed' };

    const { state } = claim;
    claimedState = state;
    const initialResponse = await client.readJsonWithHeaders(pagePath(state, 1));
    const initialTotals = readPageTotals(initialResponse.headers);
    if (!initialTotals) {
      await markFailed(admin, state, 'pagination_headers_invalid');
      return { ok: false, errorCode: 'pagination_headers_invalid' };
    }

    let previous: { readonly createdAt: string | null; readonly externalOrderId: string } | null =
      null;
    const externalIds = new Set<string>();

    for (let page = 1; page <= initialTotals.totalPages; page += 1) {
      const response =
        page === 1 ? initialResponse : await client.readJsonWithHeaders(pagePath(state, page));
      const totals = readPageTotals(response.headers);
      if (!totals) {
        await markFailed(admin, state, 'pagination_headers_invalid');
        return { ok: false, errorCode: 'pagination_headers_invalid' };
      }
      if (totals.total !== initialTotals.total || totals.totalPages !== initialTotals.totalPages) {
        await markFailed(admin, state, 'pagination_total_changed');
        return { ok: false, errorCode: 'pagination_total_changed' };
      }
      if (!Array.isArray(response.data)) {
        await markFailed(admin, state, 'order_payload_invalid');
        return { ok: false, errorCode: 'order_payload_invalid' };
      }

      const pageOrders: PersistableCanonicalOrder[] = [];
      for (const rawOrder of response.data) {
        const order = mapWooCommerceOrder(rawOrder);
        if (!order) {
          await markFailed(admin, state, 'order_payload_invalid');
          return { ok: false, errorCode: 'order_payload_invalid' };
        }
        const position = {
          createdAt: order.data.createdAt,
          externalOrderId: order.externalOrderId,
        };
        if (previous && compareOrderPosition(previous, position) !== -1) {
          await markFailed(admin, state, 'pagination_not_monotone');
          return { ok: false, errorCode: 'pagination_not_monotone' };
        }
        previous = position;
        pageOrders.push(order);
      }

      for (const order of pageOrders) {
        externalIds.add(order.externalOrderId);

        if (insideWindow(order.data.createdAt, state)) {
          const persisted = await persistWooCommerceCanonicalOrder({
            supabase: admin,
            context: connectionResult.connection.context,
            topic: 'order.updated',
            deliveryId: null,
            order,
          });
          if (!persisted.ok) {
            await markFailed(admin, state, 'order_persist_failed');
            return { ok: false, errorCode: 'order_persist_failed' };
          }
        }
      }

      if (
        !(await updateSyncState(admin, state, {
          last_page_observed: page,
          updated_at: new Date().toISOString(),
        }))
      ) {
        await markFailed(admin, state, 'sync_state_failed');
        return { ok: false, errorCode: 'sync_state_failed' };
      }
    }

    if (externalIds.size !== initialTotals.total) {
      await markFailed(admin, state, 'pagination_resource_count_mismatch');
      return { ok: false, errorCode: 'pagination_resource_count_mismatch' };
    }

    if (
      !(await updateSyncState(admin, state, {
        status: 'completed',
        last_page_observed: initialTotals.totalPages,
        last_error_code: null,
        updated_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      }))
    ) {
      await markFailed(admin, state, 'sync_state_failed');
      return { ok: false, errorCode: 'sync_state_failed' };
    }
    return { ok: true, status: 'completed' };
  } catch (error) {
    if (isCredentialInvalid(error)) {
      await admin
        .from('store_connection')
        .update({ status: 'needs_reauth' })
        .eq('id', connectionId)
        .eq('platform', 'woocommerce');
      if (claimedState) await markFailed(admin, claimedState, 'credentials_invalid');
      return { ok: false, errorCode: 'credentials_invalid' };
    }
    if (claimedState) await markFailed(admin, claimedState, 'sync_remote_failed');
    return { ok: false, errorCode: 'sync_remote_failed' };
  }
}

/** Lance ou reprend la synchronisation initiale ; une seule exécution active par connexion. */
export async function synchronizeWooCommerceOrders(
  connectionId: string,
  dependencies: SyncDependencies = {},
): Promise<WooCommerceSyncResult> {
  if (syncLocks.has(connectionId)) {
    return { ok: false, errorCode: 'sync_already_running' };
  }
  const current = runSync(connectionId, dependencies);
  syncLocks.set(connectionId, current);
  try {
    return await current;
  } finally {
    if (syncLocks.get(connectionId) === current) syncLocks.delete(connectionId);
  }
}
