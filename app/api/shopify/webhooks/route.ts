import { verifyWebhookHmac } from '@/lib/shopify/webhook-verify';
import type { Database } from '@/lib/supabase/database.types';
import { createClient } from '@supabase/supabase-js';

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

async function insertWebhookEvent({
  supabase,
  webhookId,
  topic,
  shopDomain,
}: {
  supabase: NonNullable<SupabaseAdminClient>;
  webhookId: string;
  topic: string;
  shopDomain: string | null;
}): Promise<{ duplicate: boolean; eventId: string | null }> {
  const { data, error } = await supabase
    .from('webhook_event')
    .insert({
      shopify_webhook_id: webhookId,
      topic,
      shop_domain: shopDomain,
    })
    .select('id')
    .single();

  if (error) {
    if (error.code === '23505') {
      logWebhookInfo('[webhook] duplicate ignored', { topic, webhookId });
      return { duplicate: true, eventId: null };
    }

    logWebhookError('[webhook] dedup insert failed', {
      code: error.code,
      details: error.details,
      hint: error.hint,
      message: error.message,
      topic,
      webhookId,
    });
    return { duplicate: false, eventId: null };
  }

  return { duplicate: false, eventId: data.id };
}

async function markWebhookProcessed({
  supabase,
  eventId,
}: {
  supabase: NonNullable<SupabaseAdminClient>;
  eventId: string;
}) {
  const { error } = await supabase
    .from('webhook_event')
    .update({ processed: true })
    .eq('id', eventId);

  if (error) {
    logWebhookError('[webhook] processed update failed', {
      code: error.code,
      details: error.details,
      hint: error.hint,
      message: error.message,
      eventId,
    });
  }
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const hmacHeader = request.headers.get('x-shopify-hmac-sha256');
  const topic = request.headers.get('x-shopify-topic') ?? 'unknown';
  const shopDomain = request.headers.get('x-shopify-shop-domain');
  const webhookId = request.headers.get('x-shopify-webhook-id');

  if (!verifyWebhookHmac(rawBody, hmacHeader, process.env.SHOPIFY_API_SECRET ?? '')) {
    logWebhookError('[webhook] invalid hmac', { topic });
    return new Response(null, { status: 401 });
  }

  const supabase = createSupabaseAdminClient();

  if (!supabase) {
    logWebhookError('[webhook] missing supabase service-role env', { topic });
    return ok();
  }

  if (!webhookId) {
    logWebhookError('[webhook] missing webhook id', { topic });
    return ok();
  }

  const { duplicate, eventId } = await insertWebhookEvent({
    supabase,
    webhookId,
    topic,
    shopDomain,
  });

  if (duplicate) {
    return ok();
  }

  try {
    const payload = JSON.parse(rawBody) as unknown;
    void payload;
  } catch (error) {
    logWebhookError('[webhook] invalid json payload', { error, topic });
    return ok();
  }

  switch (topic) {
    case 'orders/create':
      logWebhookInfo('[webhook] orders/create received', shopDomain);
      break;
    case 'orders/updated':
      logWebhookInfo('[webhook] orders/updated received');
      break;
    case 'app/uninstalled':
      logWebhookInfo('[webhook] app/uninstalled received');
      break;
    case 'customers/data_request':
    case 'customers/redact':
    case 'shop/redact':
      logWebhookInfo('[webhook] gdpr received', topic);
      break;
    default:
      logWebhookInfo('[webhook] unhandled topic', topic);
      break;
  }

  if (eventId) {
    await markWebhookProcessed({ supabase, eventId });
  }

  return ok();
}
