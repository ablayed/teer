// Phase 2 / Lot L3 + Verrou 0 — endpoint webhook à URL opaque par installation.
//
// Ordre d'autorité, dans cet ordre, jamais inversé : URL (jeton) → connexion → platform_app_id →
// HMAC du corps → comparaison de l'en-tête. Chaque étape ne peut être décidée que par la
// précédente ; l'en-tête n'intervient JAMAIS avant la dernière étape, à titre de garde-fou comparé
// seulement — jamais autoritatif.
//
// Six causes de refus distinctes en interne (jeton malformé, inconnu, expiré, mauvais secret, HMAC
// invalide, en-tête divergent) + une 7ᵉ (désaccord app/jeton, recoupement L2) → UNE SEULE réponse
// externe (401, corps vide), pour toutes. Un appelant ne doit jamais pouvoir distinguer ces cas.
// Toutes vérifiées AVANT tout appel au cœur métier — le cœur n'est jamais atteint avec un contexte
// douteux (preuve : absence de ligne dans webhook_event/ingestion_event/orders/product, pas
// seulement le code de réponse — cf. tests/e2e/shopify-ingest-token-endpoint.spec.ts).
//
// Verrou 0 (rapport de session dédié) : cet endpoint appelle désormais le MÊME cœur métier que
// l'endpoint legacy (lib/shopify/webhook-core.ts) — webhook_event redevient alimenté ici aussi
// (autoritaire en lecture, Phase 2), la persistance orders/product/refund/app-uninstalled est
// complète (plus seulement le registre L1/L2 ingestion_event/external_ref). Le cœur ne lit ni
// en-tête, ni jeton, ni URL : il reçoit une boutique déjà résolue via le jeton (jamais un domaine).
import {
  finalizeResolvedConnection,
  resolveConnectionByToken,
} from '@/lib/ingestion/resolve-connection';
import { identifyValidatingApps } from '@/lib/shopify/adapter';
import { getRegisteredShopifyApps } from '@/lib/shopify/apps';
import {
  recordWebhookReceipt,
  resolveShopForTopic,
  runResolvedWebhookEvent,
  toJson,
} from '@/lib/shopify/webhook-core';
import type { Database } from '@/lib/supabase/database.types';
import { createProtectedSupabaseClient } from '@/lib/supabase/protected-client';
import * as Sentry from '@sentry/nextjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function createSupabaseAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return null;
  }

  return createProtectedSupabaseClient(supabaseUrl, serviceRoleKey, {
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

  // Étape 4 — comparaison de l'en-tête : garde-fou comparé, jamais autoritatif. La connexion est
  // déjà entièrement déterminée par le jeton ; une divergence signale une requête incohérente,
  // jamais une source d'identité alternative.
  if (headerShopDomain && headerShopDomain !== connection.externalIdentifier) {
    return refuse('header_mismatch', { topic, webhookId });
  }

  // Identité prouvée. Aucun refus possible après ce point — tout ce qui suit passe par le MÊME
  // cœur que l'endpoint legacy, jamais un traitement ad hoc.
  if (!webhookId) {
    // biome-ignore lint/suspicious/noConsole: journal opérationnel, miroir de l'endpoint legacy.
    console.error('[ingest] missing webhook id', { topic });
    return new Response(null, { status: 200 });
  }

  const payload = parseJsonSafely(rawBody);

  // shop_domain déjà connu sans requête (connection.externalIdentifier EST le domaine, résolu par
  // le jeton) ; shopId/merchantAccountId déjà connus via la connexion. webhook_event est donc
  // alimenté SANS lookup supplémentaire côté bookkeeping, contrairement à legacy (qui doit, lui,
  // résoudre une boutique depuis un en-tête non prouvé).
  const receipt = await recordWebhookReceipt({
    supabase,
    webhookId,
    topic,
    shopDomain: connection.externalIdentifier,
    shopId: connection.shopId,
    merchantAccountId: connection.merchantAccountId,
    triggeredAt,
    payload: toJson(payload),
  });

  if (receipt.error) {
    return new Response(null, { status: 503 });
  }

  if (receipt.duplicate) {
    // Contrairement à legacy (after() + réclamation asynchrone), cet endpoint reste synchrone :
    // un doublon retryable dû est retraité immédiatement, avant la réponse — pas de fenêtre
    // d'attente d'un cron/retry externe. Le résultat final (webhook_event.status) est identique.
    const due =
      receipt.status === 'retryable' &&
      (receipt.nextAttemptAt === null || Date.parse(receipt.nextAttemptAt) <= Date.now());
    if (!due || !receipt.eventId) {
      return new Response(null, { status: 200 });
    }
    const shop = await resolveShopForTopic(supabase, topic, {
      by: 'id',
      shopId: connection.shopId,
    });
    await runResolvedWebhookEvent({
      supabase,
      eventId: receipt.eventId,
      shop,
      topic,
      payload: receipt.payload,
      webhookId,
      triggeredAt,
    });
    return new Response(null, { status: 200 });
  }

  const shop = await resolveShopForTopic(supabase, topic, { by: 'id', shopId: connection.shopId });

  // Les topics GDPR (customers/data_request, customers/redact, shop/redact) ne sont jamais
  // souscriptibles via l'Admin API (enum WebhookSubscriptionTopic, vérifié dans le lot précédent)
  // — ils n'atteignent donc structurellement jamais cet endpoint. dispatchWebhookCore les
  // traiterait quand même correctement s'ils arrivaient ici (même dispatcher que legacy), mais
  // aucun trafic Shopify réel ne peut emprunter ce chemin pour ces trois topics.
  await runResolvedWebhookEvent({
    supabase,
    eventId: receipt.eventId as string,
    shop,
    topic,
    payload,
    webhookId,
    triggeredAt,
  });

  return new Response(null, { status: 200 });
}
