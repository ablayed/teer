// Phase 2 — Verrou 0 : endpoint legacy, comportement observable STRICTEMENT INCHANGÉ. Résout
// l'identité par l'en-tête x-shopify-shop-domain (comme avant), délègue tout le traitement
// métier au cœur partagé (lib/shopify/webhook-core.ts) — le cœur ne lit ni en-tête ni jeton ni
// URL, il reçoit une boutique déjà résolue.
import { checkRateLimit } from '@/lib/security/rate-limit';
import { getRegisteredShopifyApps, getShopifyAppForShop } from '@/lib/shopify/apps';
import {
  type WebhookShopRow,
  finishWebhookStatus,
  isReceiptDue,
  isTerminalWebhookError,
  recordWebhookReceipt,
  resolveShopForTopic,
  resolveShopLenient,
  runResolvedWebhookEvent,
  toJson,
} from '@/lib/shopify/webhook-core';
import { verifyWebhookHmacAnySecret } from '@/lib/shopify/webhook-verify';
import type { Database } from '@/lib/supabase/database.types';
import { createProtectedSupabaseClient } from '@/lib/supabase/protected-client';
import { after } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SupabaseAdminClient = ReturnType<typeof createSupabaseAdminClient>;

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

function ok() {
  return new Response(null, { status: 200 });
}

function logWebhookError(message: string, ...details: unknown[]) {
  // biome-ignore lint/suspicious/noConsole: 5A webhook foundation intentionally logs invalid signatures and storage failures.
  console.error(message, ...details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

function resolveShopDomain(headerShopDomain: string | null, payload: unknown): string | null {
  if (headerShopDomain) {
    return headerShopDomain;
  }

  if (!isRecord(payload)) {
    return null;
  }

  return stringField(payload, 'shop_domain') ?? stringField(payload, 'myshopify_domain');
}

type SignedShopDomainResult =
  | { ok: true; shopDomain: string }
  | { ok: false; reason: 'missing' | 'mismatch' };

// Résolution AUTORITATIVE de la boutique pour les topics dont le corps signé porte l'identité
// (customers/data_request, customers/redact, shop/redact, app/uninstalled) — PAS pour orders/*,
// products/*, refunds/create, bulk_operations/finish, dont le corps Shopify ne contient jamais
// de shop_domain/shop_id (vérifié contre les fixtures E2E de ce dépôt, incident 2026-08-23).
//
// x-shopify-hmac-sha256 ne couvre QUE le corps brut — jamais les en-têtes. x-shopify-shop-domain
// n'est donc pas authentifié. Un secret d'app Shopify est partagé par TOUTES les boutiques
// installées sous cette app (lib/shopify/apps.ts : 4 apps fixes, dont teer-dev = app publique par
// défaut) — un HMAC valide prouve seulement « signé par une boutique de cette app », jamais
// laquelle. Un attaquant capturant un (rawBody, hmac) valide pour SA PROPRE boutique peut donc le
// rejouer avec un x-shopify-shop-domain forgé désignant une boutique VICTIME de la même app, tant
// que rien ne confronte le domaine du header à celui du corps signé.
//
// Contrat : le shop_domain du CORPS est la seule source de confiance ; le header n'est comparé à
// titre de garde-fou. Toute divergence, ou absence des deux, refuse AVANT toute écriture.
// `allowHeaderFallback` n'existe que pour app/uninstalled, dont le corps peut arriver vide selon
// le SDK Shopify (comportement Shopify externe, non vérifiable depuis ce dépôt) — ne jamais le
// passer à true pour un autre appelant.
function resolveSignedShopDomain(
  headerShopDomain: string | null,
  payload: unknown,
  { allowHeaderFallback = false }: { allowHeaderFallback?: boolean } = {},
): SignedShopDomainResult {
  const bodyShopDomain = isRecord(payload)
    ? (stringField(payload, 'shop_domain') ?? stringField(payload, 'myshopify_domain'))
    : null;

  if (bodyShopDomain) {
    if (headerShopDomain && headerShopDomain !== bodyShopDomain) {
      return { ok: false, reason: 'mismatch' };
    }
    return { ok: true, shopDomain: bodyShopDomain };
  }

  if (allowHeaderFallback && headerShopDomain) {
    return { ok: true, shopDomain: headerShopDomain };
  }

  return { ok: false, reason: 'missing' };
}

async function getShopByDomain({
  shopDomain,
  supabase,
}: {
  shopDomain: string;
  supabase: NonNullable<SupabaseAdminClient>;
}) {
  return resolveShopLenient(supabase, { by: 'domain', shopDomain });
}

function isSignedShopDomainTopic(topic: string): boolean {
  return (
    topic === 'customers/data_request' ||
    topic === 'customers/redact' ||
    topic === 'shop/redact' ||
    topic === 'app/uninstalled'
  );
}

function logMissingDomainForTolerantTopic(topic: string): void {
  if (
    topic === 'orders/create' ||
    topic === 'orders/updated' ||
    topic === 'orders/cancelled' ||
    topic === 'orders/fulfilled'
  ) {
    logWebhookError('[webhook] order webhook missing shop domain', { topic });
  } else if (topic === 'products/create' || topic === 'products/update') {
    logWebhookError('[webhook] product webhook missing shop domain', { topic });
  } else if (topic === 'refunds/create') {
    logWebhookError('[webhook] refund missing shop domain', { topic });
  } else if (topic === 'bulk_operations/finish') {
    logWebhookError('[webhook] bulk finish missing shop domain', { topic });
  }
}

type LegacyShopResolution =
  | { ok: true; shop: WebhookShopRow | null }
  | { ok: false; errorCode: string };

// Résolution boutique topic-tolérante — legacy-only (lit l'en-tête/le corps), TOUJOURS
// re-résolue ici (jamais réutilisée depuis le lookup lénient de bookkeeping fait dans POST) :
// un shop trouvé pour webhook_event peut être inactif alors que orders/* exige status='active'.
// Pour les topics signés (GDPR/app-uninstalled), une résolution manquante/divergente est une
// erreur TERMINALE avec un code précis — jamais un simple "shop null" tel que le cœur le tolère
// pour les autres topics.
async function resolveLegacyShopForTopic(
  supabase: NonNullable<SupabaseAdminClient>,
  topic: string,
  headerShopDomain: string | null,
  payload: unknown,
): Promise<LegacyShopResolution> {
  if (isSignedShopDomainTopic(topic)) {
    const resolved = resolveSignedShopDomain(headerShopDomain, payload, {
      allowHeaderFallback: topic === 'app/uninstalled',
    });
    const isGdpr = topic !== 'app/uninstalled';

    if (!resolved.ok) {
      const errorCode =
        resolved.reason === 'mismatch'
          ? isGdpr
            ? 'gdpr_shop_domain_mismatch'
            : 'shopify_uninstall_shop_domain_mismatch'
          : isGdpr
            ? 'gdpr_shop_domain_missing'
            : 'shopify_uninstall_shop_domain_missing';
      logWebhookError(`[webhook] ${topic} shop domain ${resolved.reason}`, {
        topic,
        headerShopDomain,
      });
      return { ok: false, errorCode };
    }

    const shop = await resolveShopForTopic(supabase, topic, {
      by: 'domain',
      shopDomain: resolved.shopDomain,
    });
    return { ok: true, shop };
  }

  const domain = resolveShopDomain(headerShopDomain, payload);
  if (!domain) {
    logMissingDomainForTolerantTopic(topic);
    return { ok: true, shop: null };
  }
  const shop = await resolveShopForTopic(supabase, topic, { by: 'domain', shopDomain: domain });
  return { ok: true, shop };
}

async function runWebhookEvent({
  eventId,
  payload,
  shopDomain,
  supabase,
  topic,
  replay,
  webhookId,
  triggeredAt,
}: {
  eventId: string;
  payload: unknown;
  shopDomain: string | null;
  supabase: NonNullable<SupabaseAdminClient>;
  topic: string;
  replay: boolean;
  webhookId: string | null;
  triggeredAt: string | null;
}) {
  let effectivePayload = payload;
  let effectiveShopDomain = shopDomain;
  let effectiveTopic = topic;

  if (replay) {
    const { data: claimed, error } = await supabase.rpc('claim_shopify_webhook_events', {
      p_event_id: eventId,
      p_limit: 1,
    });
    if (error) {
      logWebhookError('[webhook] retry claim failed', { eventId, code: error.code });
      return;
    }
    const event = claimed?.[0];
    if (!event || event.payload === null) {
      return;
    }
    effectivePayload = event.payload;
    effectiveShopDomain = event.shop_domain;
    effectiveTopic = event.topic;
  }

  const resolution = await resolveLegacyShopForTopic(
    supabase,
    effectiveTopic,
    effectiveShopDomain,
    effectivePayload,
  );

  if (!resolution.ok) {
    await finishWebhookStatus({
      supabase,
      eventId,
      outcome: isTerminalWebhookError(new Error(resolution.errorCode)) ? 'terminal' : 'retryable',
      errorCode: resolution.errorCode,
    });
    return;
  }

  await runResolvedWebhookEvent({
    supabase,
    eventId,
    shop: resolution.shop,
    topic: effectiveTopic,
    payload: effectivePayload,
    webhookId,
    triggeredAt,
  });
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const hmacHeader = request.headers.get('x-shopify-hmac-sha256');
  const topic = request.headers.get('x-shopify-topic') ?? 'unknown';
  const shopDomain = request.headers.get('x-shopify-shop-domain');
  const webhookId = request.headers.get('x-shopify-webhook-id');
  const triggeredAt = request.headers.get('x-shopify-triggered-at');

  const supabase = createSupabaseAdminClient();

  // Multi-app : on route le secret HMAC vers l'app émettrice. La boutique mémorise shopify_client_id
  // à l'install → on l'utilise (lookup par le header x-shopify-shop-domain, valeur non fiable mais
  // sans risque : un mauvais domaine sélectionne le mauvais secret → l'HMAC échoue → 401).
  // Boutique inconnue de la base (conformité, désinstallée, jamais installée) → on essaie TOUS les
  // secrets enregistrés pour rester vérifié sur les DEUX apps.
  const registeredSecrets = getRegisteredShopifyApps().map((app) => app.clientSecret);
  const fallbackSecrets =
    registeredSecrets.length > 0 ? registeredSecrets : [process.env.SHOPIFY_API_SECRET ?? ''];

  const headerShop =
    supabase && shopDomain ? await getShopByDomain({ shopDomain, supabase }) : null;
  const headerApp = headerShop ? getShopifyAppForShop(headerShop.shopify_client_id) : null;
  const hmacSecrets = headerApp ? [headerApp.clientSecret] : fallbackSecrets;

  // HMAC vérifié AVANT tout traitement.
  if (!verifyWebhookHmacAnySecret(rawBody, hmacHeader, hmacSecrets)) {
    logWebhookError('[webhook] invalid hmac', { topic });
    return new Response(null, { status: 401 });
  }

  if (!supabase) {
    logWebhookError('[webhook] missing supabase service-role env', { topic });
    return ok();
  }

  if (!webhookId) {
    logWebhookError('[webhook] missing webhook id', { topic });
    return ok();
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody) as unknown;
  } catch (error) {
    logWebhookError('[webhook] invalid json payload', { error, topic });
    return ok();
  }

  // Contexte boutique/tenant pour la ligne de dédup (résolution légère par domaine).
  // On réutilise la boutique déjà chargée pour le routage HMAC quand le domaine concorde.
  const resolvedShopDomain = resolveShopDomain(shopDomain, payload);
  if (resolvedShopDomain) {
    const rateLimit = await checkRateLimit('shopify_webhook', `webhook:${resolvedShopDomain}`);
    if (!rateLimit.ok) {
      logWebhookError('[webhook] rate limit exceeded', { topic, resolvedShopDomain });
      return new Response(null, { headers: { 'retry-after': '60' }, status: 429 });
    }
  }

  const shop = resolvedShopDomain
    ? headerShop && headerShop.shop_domain === resolvedShopDomain
      ? headerShop
      : await getShopByDomain({ shopDomain: resolvedShopDomain, supabase })
    : null;

  // Idempotence : insert dédup par webhook_id. Un événement retryable arrivé
  // à échéance est réclamé à nouveau dans after().
  const receipt = await recordWebhookReceipt({
    supabase,
    webhookId,
    topic,
    shopDomain: resolvedShopDomain,
    shopId: shop?.id ?? null,
    merchantAccountId: shop?.merchant_account_id ?? null,
    triggeredAt,
    payload: toJson(payload),
  });

  if (receipt.error) {
    return new Response(null, { status: 503 });
  }

  if (receipt.duplicate) {
    if (isReceiptDue(receipt) && receipt.eventId) {
      after(() =>
        runWebhookEvent({
          eventId: receipt.eventId as string,
          payload: receipt.payload,
          shopDomain,
          supabase,
          topic,
          replay: true,
          webhookId,
          triggeredAt,
        }),
      );
    }
    return ok();
  }

  // 200 rapide (< 5 s) : le traitement métier s'exécute APRÈS la réponse (after()).
  after(() =>
    runWebhookEvent({
      eventId: receipt.eventId as string,
      payload,
      shopDomain,
      supabase,
      topic,
      replay: false,
      webhookId,
      triggeredAt,
    }),
  );

  return ok();
}
