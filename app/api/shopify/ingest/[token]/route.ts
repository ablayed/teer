// Phase 2 / Lot L3 (périmètre réduit) — endpoint webhook à URL opaque par installation.
//
// Ordre d'autorité, dans cet ordre, jamais inversé : URL (jeton) → connexion → platform_app_id →
// HMAC du corps → comparaison de l'en-tête. Chaque étape ne peut être décidée que par la
// précédente ; l'en-tête n'intervient JAMAIS avant la dernière étape, à titre de garde-fou comparé
// seulement — jamais autoritatif.
//
// Six causes de refus distinctes en interne (jeton malformé, inconnu, expiré, mauvais secret, HMAC
// invalide, en-tête divergent) + une 7ᵉ (désaccord app/jeton, recoupement L2) → UNE SEULE réponse
// externe (401, corps vide), pour toutes. Un appelant ne doit jamais pouvoir distinguer ces cas.
//
// Portée volontairement réduite de ce lot (cf. rapport de session) : cet endpoint prouve
// l'identité/le routage via le registre canonique déjà posé par L2 (ingestion_event/external_ref) —
// il n'appelle PAS encore les écritures métier legacy (persistShopifyOrder et alliés, qui restent
// la seule voie qui alimente réellement `orders`/`product`). Aucun abonnement Shopify réel ne
// pointe vers cet endpoint dans ce lot (la bascule d'abonnements est un lot séparé, hors périmètre
// L3 réduit) : il n'accepte donc aucun trafic Shopify de production à ce stade, seulement le
// trafic de test qui prouve les propriétés ci-dessus.
import {
  finalizeResolvedConnection,
  resolveConnectionByToken,
} from '@/lib/ingestion/resolve-connection';
import {
  writeBulkOperationIngestion,
  writeOrderIngestion,
  writeProductIngestion,
  writeRefundIngestion,
} from '@/lib/ingestion/shopify-dual-write';
import {
  identifyValidatingApps,
  normalizeShopifyBulkOperationFinished,
} from '@/lib/shopify/adapter';
import { getRegisteredShopifyApps } from '@/lib/shopify/apps';
import { deriveRefundWebhook } from '@/lib/shopify/refunds';
import type { Database } from '@/lib/supabase/database.types';
import * as Sentry from '@sentry/nextjs';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

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

// Toutes les causes de refus d'identité (jeton + HMAC + recoupement d'app + en-tête) — six causes
// internes du lot, plus le désaccord app/jeton — convergent ici vers UNE réponse unique.
type IngestRefusalReason =
  | 'malformed_token'
  | 'unknown_token'
  | 'revoked'
  | 'secret_expired'
  | 'secret_mismatch'
  | 'connection_inactive'
  | 'hmac_invalid'
  | 'app_mismatch'
  // Jamais réellement émise par finalizeResolvedConnection (qui ne fait pas de lookup — la
  // connexion est déjà résolue par le jeton), mais partagée par le type ConnectionRefusalReason
  // que finalizeResolvedConnection retourne : gardée ici pour rester exhaustif sans caster.
  | 'unknown_connection'
  | 'header_mismatch';

function refuse(reason: IngestRefusalReason, extra: Record<string, unknown> = {}): Response {
  // biome-ignore lint/suspicious/noConsole: journal interne des causes de refus (jamais exposé au demandeur).
  console.error('[ingest] refused', { reason, ...extra });
  return new Response(null, { status: 401 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractResourceId(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const id = payload.id;
  if (typeof id === 'string') {
    return id;
  }
  if (typeof id === 'number' && Number.isFinite(id)) {
    return String(id);
  }
  return null;
}

function parseJsonSafely(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;
  const rawBody = await request.text();
  const hmacHeader = request.headers.get('x-shopify-hmac-sha256');
  const topic = request.headers.get('x-shopify-topic') ?? 'unknown';
  const headerShopDomain = request.headers.get('x-shopify-shop-domain');
  const webhookId = request.headers.get('x-shopify-webhook-id');
  const triggeredAt = request.headers.get('x-shopify-triggered-at');

  const supabase = createSupabaseAdminClient();
  if (!supabase) {
    Sentry.captureException(new Error('shopify_ingest_supabase_admin_client_unavailable'));
    return new Response(null, { status: 500 });
  }

  // Étape 1 — URL → connexion. Aucune lecture d'en-tête ni de corps ici.
  const tokenResult = await resolveConnectionByToken(supabase, token);
  if (!tokenResult.ok) {
    return refuse(tokenResult.reason);
  }
  const { connection } = tokenResult;

  // Étape 2 — identification de l'app qui a réellement validé le HMAC, parmi TOUTES les apps
  // enregistrées (jamais un court-circuit sur l'app attendue par le jeton — c'est précisément ce
  // qui permet à l'étape 3 de distinguer « HMAC invalide » de « désaccord app/jeton »).
  const apps = getRegisteredShopifyApps().map((app) => ({
    clientId: app.clientId,
    clientSecret: app.clientSecret,
  }));
  const validatingApps = identifyValidatingApps(rawBody, hmacHeader, apps);
  if (validatingApps.length !== 1) {
    return refuse('hmac_invalid', { topic, webhookId });
  }

  // Étape 3 — platform_app_id → recoupement. Même contrôle, même raison de refus que le point
  // d'entrée legacy (lib/ingestion/resolve-connection.ts `resolveConnectionForWebhook`).
  const resolved = finalizeResolvedConnection(connection, { clientId: validatingApps[0].clientId });
  if (!resolved.ok) {
    return refuse(resolved.reason, { topic, webhookId });
  }
  const ctx = resolved.context;

  // Étape 4 — comparaison de l'en-tête : garde-fou comparé, jamais autoritatif. La connexion est
  // déjà entièrement déterminée par le jeton ; une divergence signale une requête incohérente,
  // jamais une source d'identité alternative.
  if (headerShopDomain && headerShopDomain !== connection.externalIdentifier) {
    return refuse('header_mismatch', { topic, webhookId });
  }

  const payload = parseJsonSafely(rawBody);

  await processIngestedEvent(supabase, ctx, {
    topic,
    payload,
    deliveryId: webhookId,
    triggeredAt,
  });

  return new Response(null, { status: 200 });
}

// Best-effort, à l'image de lib/ingestion/shopify-dual-write.ts : aucune erreur de traitement ne
// doit transformer un événement dont l'identité est déjà prouvée en échec HTTP — la preuve de
// sécurité de ce lot porte sur l'identité/le routage, pas sur la résilience complète du pipeline
// métier (hors périmètre réduit, cf. rapport de session).
async function processIngestedEvent(
  supabase: NonNullable<AdminClient>,
  ctx: Parameters<typeof writeOrderIngestion>[1],
  {
    topic,
    payload,
    deliveryId,
    triggeredAt,
  }: { topic: string; payload: unknown; deliveryId: string | null; triggeredAt: string | null },
): Promise<void> {
  try {
    switch (topic) {
      case 'orders/create':
      case 'orders/updated':
      case 'orders/cancelled':
      case 'orders/fulfilled': {
        const id = extractResourceId(payload);
        if (!id) {
          return;
        }
        await writeOrderIngestion(supabase, ctx, {
          topic,
          orderNode: { id },
          deliveryId,
          triggeredAt,
        });
        return;
      }
      case 'products/create':
      case 'products/update': {
        const id = extractResourceId(payload);
        if (!id) {
          return;
        }
        const variants =
          isRecord(payload) && Array.isArray(payload.variants)
            ? payload.variants
                .filter(isRecord)
                .map((variant) => ({ node: { id: extractResourceId(variant) ?? '' } }))
                .filter((edge) => edge.node.id !== '')
            : [];
        await writeProductIngestion(supabase, ctx, {
          topic,
          productNode: { id, variants: { edges: variants } },
          deliveryId,
          triggeredAt,
        });
        return;
      }
      case 'refunds/create': {
        const refund = deriveRefundWebhook(payload);
        await writeRefundIngestion(supabase, ctx, {
          topic,
          orderId: refund.orderId,
          deliveryId,
          triggeredAt,
        });
        return;
      }
      case 'bulk_operations/finish': {
        normalizeShopifyBulkOperationFinished(payload);
        await writeBulkOperationIngestion(supabase, ctx, { topic, deliveryId, triggeredAt });
        return;
      }
      default:
        return;
    }
  } catch (error) {
    Sentry.captureException(error, {
      tags: { module: 'shopify.ingest' },
      extra: { topic, deliveryId, storeConnectionId: ctx.storeConnectionId },
    });
  }
}
