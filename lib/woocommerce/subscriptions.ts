import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  decryptConnectorCredential,
  encryptConnectorCredential,
} from '@/lib/connector-credentials/crypto';
import { env } from '@/lib/env';
import type { Database, Tables } from '@/lib/supabase/database.types';
import { createProtectedSupabaseClient } from '@/lib/supabase/protected-client';
import { WooCommerceClient, WooCommerceClientError } from '@/lib/woocommerce/client';
import type { SupabaseClient } from '@supabase/supabase-js';

export const REQUIRED_WOOCOMMERCE_WEBHOOK_TOPICS = ['order.created', 'order.updated'] as const;
type RequiredTopic = (typeof REQUIRED_WOOCOMMERCE_WEBHOOK_TOPICS)[number];
type AdminClient = SupabaseClient<Database>;
type Connection = Pick<
  Tables<'store_connection'>,
  'id' | 'merchant_account_id' | 'shop_id' | 'platform' | 'external_identifier' | 'status'
>;
type Credential = Pick<
  Tables<'store_connection_credential'>,
  'scheme' | 'consumer_key_encrypted' | 'consumer_secret_encrypted'
>;
type Subscription = Tables<'store_connection_webhook_subscription'>;
type RemoteWebhook = {
  readonly id: string;
  readonly topic: string;
  readonly status: string;
  readonly delivery_url: string;
};

export type WooCommerceSubscriptionErrorCode =
  | 'connection_not_found'
  | 'credentials_not_found'
  | 'credentials_invalid'
  | 'subscription_local_failed'
  | 'subscription_remote_failed'
  | 'subscription_verification_failed'
  | 'connection_activation_failed';

export type WooCommerceSubscriptionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errorCode: WooCommerceSubscriptionErrorCode };

type ProvisioningDependencies = {
  readonly admin?: AdminClient;
  readonly client?: WooCommerceClient;
  readonly now?: () => string;
};

const connectionLocks = new Map<string, Promise<WooCommerceSubscriptionResult>>();
const RESERVATION_LEASE_MS = 30_000;

function createSupabaseAdminClient(): AdminClient {
  return createProtectedSupabaseClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function generateDeliveryToken(): string {
  // 32 random bytes are kept only in memory and sent in the provider URL. The database stores
  // only their SHA-256 digest, so the token cannot be reconstructed from persisted columns.
  return randomBytes(32).toString('base64url');
}

function hashDeliveryToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function extractDeliveryToken(value: string): string | null {
  try {
    const url = new URL(value);
    const prefix = '/api/woocommerce/webhooks/';
    if (url.search || url.hash || !url.pathname.startsWith(prefix)) return null;
    const token = decodeURIComponent(url.pathname.slice(prefix.length));
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return token;
  } catch {
    return null;
  }
}

function deliveryUrl(token: string): string {
  return new URL(`/api/woocommerce/webhooks/${token}`, env.NEXT_PUBLIC_APP_URL).toString();
}

function isCredentialInvalid(error: unknown): boolean {
  return (
    error instanceof WooCommerceClientError &&
    (error.code === 'credentials_invalid' || error.code === 'woocommerce_authentication_error')
  );
}

function providerId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9][0-9]{0,63}$/.test(value)) return value;
  return null;
}

function parseRemoteWebhook(value: unknown): RemoteWebhook | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const id = providerId(candidate.id);
  if (
    !id ||
    typeof candidate.topic !== 'string' ||
    typeof candidate.status !== 'string' ||
    typeof candidate.delivery_url !== 'string'
  ) {
    return null;
  }
  return {
    id,
    topic: candidate.topic,
    status: candidate.status,
    delivery_url: candidate.delivery_url,
  };
}

function parseRemoteWebhookList(value: unknown): RemoteWebhook[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.map(parseRemoteWebhook);
  return parsed.every((item): item is RemoteWebhook => item !== null) ? parsed : null;
}

async function loadConnection(
  admin: AdminClient,
  connectionId: string,
): Promise<Connection | null> {
  const { data, error } = await admin
    .from('store_connection')
    .select('id, merchant_account_id, shop_id, platform, external_identifier, status')
    .eq('id', connectionId)
    .maybeSingle();
  return error || !data ? null : data;
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

async function loadSubscription(
  admin: AdminClient,
  connectionId: string,
  topic: RequiredTopic,
): Promise<Subscription | null> {
  const { data, error } = await admin
    .from('store_connection_webhook_subscription')
    .select('*')
    .eq('store_connection_id', connectionId)
    .eq('topic', topic)
    .maybeSingle();
  return error || !data ? null : data;
}

async function reserveSubscription(
  admin: AdminClient,
  connection: Connection,
  topic: RequiredTopic,
  now: string,
): Promise<{ readonly local: Subscription; readonly token: string | null } | null> {
  const existing = await loadSubscription(admin, connection.id, topic);
  if (existing) {
    if (
      existing.status === 'provisioning' &&
      !existing.provider_subscription_id &&
      Date.now() - Date.parse(existing.updated_at) < RESERVATION_LEASE_MS
    ) {
      // A different process may own the freshly inserted reservation. Wait for its provider id;
      // an abandoned reservation becomes reclaimable after the bounded lease.
      let current = existing;
      while (Date.now() - Date.parse(current.updated_at) < RESERVATION_LEASE_MS) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const refreshed = await loadSubscription(admin, connection.id, topic);
        if (
          !refreshed ||
          refreshed.provider_subscription_id ||
          refreshed.status !== 'provisioning'
        ) {
          return refreshed ? { local: refreshed, token: null } : null;
        }
        current = refreshed;
      }
      return { local: current, token: null };
    }
    return { local: existing, token: null };
  }

  const id = randomUUID();
  const token = generateDeliveryToken();
  const secret = randomBytes(32).toString('hex');
  const { data, error } = await admin
    .from('store_connection_webhook_subscription')
    .insert({
      id,
      store_connection_id: connection.id,
      merchant_account_id: connection.merchant_account_id,
      shop_id: connection.shop_id,
      topic,
      delivery_token_hash: hashDeliveryToken(token),
      secret_encrypted: encryptConnectorCredential(secret),
      status: 'provisioning',
      created_at: now,
      updated_at: now,
    })
    .select('*')
    .single();

  if (!error && data) return { local: data, token };
  if (error?.code !== '23505') return null;
  // A concurrent provisioner reserved the same topic. Re-read the unique row; never create a
  // second local line or derive shop context from a provider response.
  const concurrent = await loadSubscription(admin, connection.id, topic);
  return concurrent ? { local: concurrent, token: null } : null;
}

async function listRemoteWebhooks(client: WooCommerceClient): Promise<RemoteWebhook[]> {
  const value = await client.readJson('wp-json/wc/v3/webhooks');
  const parsed = parseRemoteWebhookList(value);
  if (!parsed) throw new Error('subscription_remote_shape_invalid');
  return parsed;
}

async function readAndVerifyRemoteWebhook(
  client: WooCommerceClient,
  providerSubscriptionId: string,
  topic: RequiredTopic,
  expectedDeliveryTokenHash: string,
): Promise<boolean> {
  const value = await client.readJson(
    `wp-json/wc/v3/webhooks/${encodeURIComponent(providerSubscriptionId)}`,
  );
  const webhook = parseRemoteWebhook(value);
  const token = webhook ? extractDeliveryToken(webhook.delivery_url) : null;
  return Boolean(
    webhook &&
      webhook.id === providerSubscriptionId &&
      webhook.topic === topic &&
      webhook.status === 'active' &&
      token &&
      hashDeliveryToken(token) === expectedDeliveryTokenHash &&
      deliveryUrl(token) === webhook.delivery_url,
  );
}

function matchingRemoteWebhooks(
  webhooks: readonly RemoteWebhook[],
  topic: RequiredTopic,
  deliveryTokenHash: string,
): RemoteWebhook[] {
  return webhooks.filter((webhook) => {
    const token = extractDeliveryToken(webhook.delivery_url);
    return (
      webhook.topic === topic &&
      token !== null &&
      hashDeliveryToken(token) === deliveryTokenHash &&
      deliveryUrl(token) === webhook.delivery_url
    );
  });
}

async function replaceDeliveryTokenHash(
  admin: AdminClient,
  local: Subscription,
  now: string,
): Promise<string | null> {
  const token = generateDeliveryToken();
  const nextHash = hashDeliveryToken(token);
  const { error } = await admin
    .from('store_connection_webhook_subscription')
    .update({ delivery_token_hash: nextHash, status: 'provisioning', updated_at: now })
    .eq('id', local.id);
  if (error) return null;
  local.delivery_token_hash = nextHash;
  return token;
}

async function findOrCreateRemoteWebhook(
  admin: AdminClient,
  client: WooCommerceClient,
  local: Subscription,
  topic: RequiredTopic,
  initialDeliveryToken: string | null,
  secret: string,
  now: string,
): Promise<string | null> {
  if (local.provider_subscription_id) {
    try {
      if (
        await readAndVerifyRemoteWebhook(
          client,
          local.provider_subscription_id,
          topic,
          local.delivery_token_hash,
        )
      ) {
        return local.provider_subscription_id;
      }
    } catch (error) {
      if (isCredentialInvalid(error)) throw error;
    }
  }

  const beforeCreate = await listRemoteWebhooks(client);
  const matching = matchingRemoteWebhooks(beforeCreate, topic, local.delivery_token_hash);
  if (matching.length > 1) throw new Error('subscription_remote_ambiguous');
  if (matching[0]) return matching[0].id;

  const deliveryToken = initialDeliveryToken ?? (await replaceDeliveryTokenHash(admin, local, now));
  if (!deliveryToken) return null;
  const expectedDeliveryUrl = deliveryUrl(deliveryToken);

  const remotePayload = {
    topic,
    delivery_url: expectedDeliveryUrl,
    // The API receives the generated HMAC secret explicitly; only its encrypted form is local.
    secret,
  };

  let createdId: string | null = null;
  try {
    const created = parseRemoteWebhook(
      await client.writeJson('wp-json/wc/v3/webhooks', remotePayload),
    );
    createdId = created?.id ?? null;
  } catch (error) {
    if (isCredentialInvalid(error)) throw error;
    // A lost response is reconciled by the same topic/hash/URL lookup before any retry.
    const afterLostResponse = await listRemoteWebhooks(client);
    const recovered = matchingRemoteWebhooks(afterLostResponse, topic, local.delivery_token_hash);
    if (recovered.length > 1) throw new Error('subscription_remote_ambiguous');
    createdId = recovered[0]?.id ?? null;
  }

  if (!createdId) {
    // A successful provider-side creation can also be represented by an unusable response body;
    // perform the same reconciliation before deciding that creation failed.
    const afterCreate = await listRemoteWebhooks(client);
    const recovered = matchingRemoteWebhooks(afterCreate, topic, local.delivery_token_hash);
    if (recovered.length > 1) throw new Error('subscription_remote_ambiguous');
    createdId = recovered[0]?.id ?? null;
  }

  if (!createdId) return null;
  return createdId;
}

async function updateSubscriptionActive(
  admin: AdminClient,
  id: string,
  providerSubscriptionId: string,
  now: string,
): Promise<boolean> {
  const { error } = await admin
    .from('store_connection_webhook_subscription')
    .update({ provider_subscription_id: providerSubscriptionId, status: 'active', updated_at: now })
    .eq('id', id);
  return !error;
}

async function updateConnectionStatus(
  admin: AdminClient,
  connectionId: string,
  status: 'active' | 'needs_reauth' | 'provisioning',
): Promise<boolean> {
  const { error } = await admin
    .from('store_connection')
    .update({ status })
    .eq('id', connectionId)
    .eq('platform', 'woocommerce');
  return !error;
}

async function runProvisioning(
  connectionId: string,
  dependencies: ProvisioningDependencies,
): Promise<WooCommerceSubscriptionResult> {
  const admin = dependencies.admin ?? createSupabaseAdminClient();
  const connection = await loadConnection(admin, connectionId);
  if (!connection || connection.platform !== 'woocommerce') {
    return { ok: false, errorCode: 'connection_not_found' };
  }

  const credential = await loadCredential(admin, connectionId);
  if (
    !credential ||
    credential.scheme !== 'basic_consumer' ||
    !credential.consumer_key_encrypted ||
    !credential.consumer_secret_encrypted
  ) {
    await updateConnectionStatus(admin, connectionId, 'provisioning');
    return { ok: false, errorCode: 'credentials_not_found' };
  }

  let client = dependencies.client;
  try {
    if (!client) {
      // Decryption is selected by the persisted scheme, never by nullable secret columns.
      const consumerKey = decryptConnectorCredential(credential.consumer_key_encrypted);
      const consumerSecret = decryptConnectorCredential(credential.consumer_secret_encrypted);
      client = new WooCommerceClient({
        baseUrl: connection.external_identifier,
        consumerKey,
        consumerSecret,
      });
    }

    for (const topic of REQUIRED_WOOCOMMERCE_WEBHOOK_TOPICS) {
      const reservation = await reserveSubscription(
        admin,
        connection,
        topic,
        dependencies.now?.() ?? new Date().toISOString(),
      );
      if (!reservation) {
        return { ok: false, errorCode: 'subscription_local_failed' };
      }

      const { local, token } = reservation;
      const providerSubscriptionId = await findOrCreateRemoteWebhook(
        admin,
        client,
        local,
        topic,
        token,
        decryptConnectorCredential(local.secret_encrypted),
        dependencies.now?.() ?? new Date().toISOString(),
      );
      if (!providerSubscriptionId) {
        return { ok: false, errorCode: 'subscription_remote_failed' };
      }

      if (
        !(await readAndVerifyRemoteWebhook(
          client,
          providerSubscriptionId,
          topic,
          local.delivery_token_hash,
        ))
      ) {
        return { ok: false, errorCode: 'subscription_verification_failed' };
      }

      if (
        !(await updateSubscriptionActive(
          admin,
          local.id,
          providerSubscriptionId,
          dependencies.now?.() ?? new Date().toISOString(),
        ))
      ) {
        return { ok: false, errorCode: 'subscription_local_failed' };
      }
    }
  } catch (error) {
    if (isCredentialInvalid(error)) {
      await updateConnectionStatus(admin, connectionId, 'needs_reauth');
    }
    return {
      ok: false,
      errorCode: isCredentialInvalid(error) ? 'credentials_invalid' : 'subscription_remote_failed',
    };
  }

  if (!(await updateConnectionStatus(admin, connectionId, 'active'))) {
    await updateConnectionStatus(admin, connectionId, 'provisioning');
    return { ok: false, errorCode: 'connection_activation_failed' };
  }
  return { ok: true };
}

/** Provisionne les deux topics requis, avec une file locale par connexion. */
export async function provisionWooCommerceSubscriptions(
  connectionId: string,
  dependencies: ProvisioningDependencies = {},
): Promise<WooCommerceSubscriptionResult> {
  const previous = connectionLocks.get(connectionId) ?? Promise.resolve({ ok: true as const });
  const current = previous.then(() => runProvisioning(connectionId, dependencies));
  connectionLocks.set(connectionId, current);
  try {
    return await current;
  } finally {
    if (connectionLocks.get(connectionId) === current) connectionLocks.delete(connectionId);
  }
}
