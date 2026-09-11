import { encryptConnectorCredential } from '@/lib/connector-credentials/crypto';
import { env } from '@/lib/env';
import { createProtectedSupabaseClient } from '@/lib/supabase/protected-client';
import { WooCommerceClient, WooCommerceClientError } from '@/lib/woocommerce/client';
import * as Sentry from '@sentry/nextjs';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_CALLBACK_BODY_BYTES = 16 * 1024;
const callbackSchema = z
  .object({
    key_id: z.string().min(1).max(256),
    user_id: z.string().uuid(),
    consumer_key: z.string().min(1).max(512),
    consumer_secret: z.string().min(1).max(512),
    key_permissions: z.string().min(1).max(32),
  })
  .strict();

type CallbackPayload = z.infer<typeof callbackSchema>;

const REFUSAL = { error: 'connection_failed' } as const;

function createSupabaseAdminClient() {
  return createProtectedSupabaseClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function refusalResponse(): NextResponse {
  return NextResponse.json(REFUSAL, { status: 400 });
}

function recordRefusal(reason: string): void {
  Sentry.captureMessage('woocommerce_callback_refused', {
    level: 'warning',
    tags: { reason },
  });
}

async function readLimitedBody(request: Request): Promise<string | null> {
  const contentLength = request.headers.get('content-length');
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > MAX_CALLBACK_BODY_BYTES
    ) {
      return null;
    }
  }

  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_CALLBACK_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(result.value);
    }
  } catch {
    return null;
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return null;
  }
}

function parseCallbackPayload(body: string): CallbackPayload | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const result = callbackSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    recordRefusal('invalid_content_type');
    return refusalResponse();
  }

  const body = await readLimitedBody(request);
  const payload = body === null ? null : parseCallbackPayload(body);
  if (!payload) {
    recordRefusal('invalid_payload');
    return refusalResponse();
  }

  const admin = createSupabaseAdminClient();
  const { data: intent, error: intentError } = await admin
    .from('store_connection_intent')
    .select('id, platform, external_identifier, expires_at, consumed_at')
    .eq('id', payload.user_id)
    .maybeSingle();
  if (intentError || !intent) {
    recordRefusal('intent_unknown');
    return refusalResponse();
  }

  if (intent.platform !== 'woocommerce') {
    recordRefusal('intent_platform_mismatch');
    return refusalResponse();
  }
  if (intent.consumed_at !== null) {
    recordRefusal('intent_consumed');
    return refusalResponse();
  }
  let verifiedIdentity: string;
  try {
    const client = new WooCommerceClient({
      baseUrl: intent.external_identifier,
      consumerKey: payload.consumer_key,
      consumerSecret: payload.consumer_secret,
    });
    // The authenticated REST call is deliberately made before the identity reread. The
    // canonical identity is still the proof used by the atomic finalizer, never this URL alone.
    await client.readApiRoot();
    const identityProof = await client.readIdentity(intent.external_identifier);
    verifiedIdentity = identityProof.canonicalIdentity;
  } catch (error) {
    const reason = error instanceof WooCommerceClientError ? error.code : 'upstream_error';
    recordRefusal(reason);
    return refusalResponse();
  }

  if (payload.key_permissions !== 'read_write') {
    recordRefusal('permissions_insufficient');
    return refusalResponse();
  }

  let encryptedConsumerKey: string;
  let encryptedConsumerSecret: string;
  try {
    encryptedConsumerKey = encryptConnectorCredential(payload.consumer_key);
    encryptedConsumerSecret = encryptConnectorCredential(payload.consumer_secret);
  } catch {
    recordRefusal('credential_encryption_failed');
    return refusalResponse();
  }

  const { data: result, error: finalizeError } = await admin.rpc(
    'finalize_woocommerce_connection',
    {
      p_intent_id: intent.id,
      p_verified_identity: verifiedIdentity,
      p_scheme: 'basic_consumer',
      p_key_id: payload.key_id,
      p_consumer_key_encrypted: encryptedConsumerKey,
      p_consumer_secret_encrypted: encryptedConsumerSecret,
      p_key_permissions: payload.key_permissions,
    },
  );
  if (finalizeError || !result?.[0]) {
    recordRefusal('finalization_failed');
    return refusalResponse();
  }

  const resultCode = result[0].result_code;
  if (resultCode !== 'ok') {
    if (resultCode === 'intent_expired') {
      // This fixed event distinguishes an orphaned provider key created after the preflight HTTP
      // succeeded. It deliberately contains neither the URL nor any credential or payload value.
      Sentry.captureMessage('woocommerce_callback_intent_expired_after_validation', {
        level: 'warning',
      });
    } else {
      recordRefusal(resultCode);
    }
    return refusalResponse();
  }

  return NextResponse.json({ ok: true });
}
