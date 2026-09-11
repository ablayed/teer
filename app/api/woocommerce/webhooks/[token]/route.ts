// R2.4 / commit 6 — réception WooCommerce.
//
// Ordre d'autorité : token opaque → abonnement → secret HMAC → connexion → identité/topic →
// payload → adaptateur → RPC métier. Aucune donnée de requête ne fournit un contexte locataire.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { decryptConnectorCredential } from '@/lib/connector-credentials/crypto';
import { env } from '@/lib/env';
import type { ResolvedConnectionContext } from '@/lib/ingestion/canonical';
import { writeIngestionEvent } from '@/lib/ingestion/dual-write';
import { resolveWooCommerceConnectionById } from '@/lib/ingestion/resolve-connection';
import type { Database } from '@/lib/supabase/database.types';
import { createProtectedSupabaseClient } from '@/lib/supabase/protected-client';
import { mapWooCommerceOrder } from '@/lib/woocommerce/adapter';
import { persistWooCommerceCanonicalOrder } from '@/lib/woocommerce/ingestion';
import { normalizeWooCommerceIdentity } from '@/lib/woocommerce/url';
import type { SupabaseClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_WEBHOOK_BODY_BYTES = 1_048_576;
type AdminClient = SupabaseClient<Database>;

function createSupabaseAdminClient(): AdminClient {
  return createProtectedSupabaseClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function refuse(): Response {
  return new Response(null, { status: 401 });
}

async function readBoundedBody(request: Request): Promise<Buffer | null> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    if (Number(declaredLength) > MAX_WEBHOOK_BODY_BYTES) return null;
  }

  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.length;
      if (total > MAX_WEBHOOK_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks);
}

function hashDeliveryToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function verifySignature(rawBody: Buffer, signature: string | null, secret: string): boolean {
  if (!signature || !secret || !/^[A-Za-z0-9+/]+=*$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('base64');
  const expectedBytes = Buffer.from(expected, 'utf8');
  const receivedBytes = Buffer.from(signature, 'utf8');
  return (
    expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes)
  );
}

function parseJson(rawBody: Buffer): unknown | null {
  try {
    return JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

function header(request: Request, name: string): string | null {
  const value = request.headers.get(name);
  return value?.trim() || null;
}

async function recordWooCommerceIngestionOutcome(
  admin: AdminClient,
  context: ResolvedConnectionContext,
  topic: 'order.created' | 'order.updated',
  deliveryId: string | null,
  status: 'retryable' | 'terminal',
  lastErrorCode: 'woocommerce_order_payload_invalid' | 'woocommerce_order_persist_failed',
): Promise<boolean> {
  try {
    const result = await writeIngestionEvent(admin, {
      ctx: context,
      topic,
      deliveryId,
      resourceKind: 'order',
      resourceExternalId: null,
      status,
      lastErrorCode,
      triggeredAt: null,
    });
    return result.ok;
  } catch {
    return false;
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const rawBody = await readBoundedBody(request);
  if (!rawBody) return refuse();

  const { token } = await context.params;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return refuse();
  const deliveryTokenHash = hashDeliveryToken(token);
  const admin = createSupabaseAdminClient();

  // Étape 1 : le token sélectionne seulement l'abonnement candidat et son secret chiffré.
  const { data: candidate, error: candidateError } = await admin
    .from('store_connection_webhook_subscription')
    .select('id, store_connection_id, topic, secret_encrypted, status, delivery_token_hash')
    .eq('delivery_token_hash', deliveryTokenHash)
    .maybeSingle();
  if (candidateError || !candidate) return refuse();

  let secret: string;
  try {
    secret = decryptConnectorCredential(candidate.secret_encrypted);
  } catch {
    return refuse();
  }

  // Étapes 2-5 : authentification cryptographique sur les octets originaux, avant tout parsing.
  if (!verifySignature(rawBody, header(request, 'x-wc-webhook-signature'), secret)) {
    return refuse();
  }

  if (candidate.status !== 'active') return refuse();
  if (candidate.topic !== 'order.created' && candidate.topic !== 'order.updated') {
    return refuse();
  }
  const connectionResult = await resolveWooCommerceConnectionById(
    admin,
    candidate.store_connection_id,
  );
  if (!connectionResult.ok) return refuse();

  const source = header(request, 'x-wc-webhook-source');
  const topic = header(request, 'x-wc-webhook-topic');
  if (!source || !topic || topic !== candidate.topic) return refuse();

  let normalizedSource: string;
  try {
    normalizedSource = normalizeWooCommerceIdentity(source);
  } catch {
    return refuse();
  }
  if (normalizedSource !== connectionResult.connection.externalIdentifier) return refuse();

  // Étapes 9-10 : le payload n'est interprété qu'après toutes les gardes d'identité.
  const deliveryId = header(request, 'x-wc-webhook-delivery-id');
  const payload = parseJson(rawBody);
  if (!payload) {
    const recorded = await recordWooCommerceIngestionOutcome(
      admin,
      connectionResult.connection.context,
      candidate.topic,
      deliveryId,
      'terminal',
      'woocommerce_order_payload_invalid',
    );
    return new Response(null, { status: recorded ? 200 : 503 });
  }
  const order = mapWooCommerceOrder(payload);
  if (!order) {
    const recorded = await recordWooCommerceIngestionOutcome(
      admin,
      connectionResult.connection.context,
      candidate.topic,
      deliveryId,
      'terminal',
      'woocommerce_order_payload_invalid',
    );
    return new Response(null, { status: recorded ? 200 : 503 });
  }

  const persisted = await persistWooCommerceCanonicalOrder({
    supabase: admin,
    context: connectionResult.connection.context,
    topic: candidate.topic,
    deliveryId,
    order,
  });
  if (!persisted.ok) {
    await recordWooCommerceIngestionOutcome(
      admin,
      connectionResult.connection.context,
      candidate.topic,
      deliveryId,
      'retryable',
      'woocommerce_order_persist_failed',
    );
    return new Response(null, { status: 503 });
  }
  return new Response(null, { status: 200 });
}
