#!/usr/bin/env node
// ============================================================================
// Phase 2 — Clôture : outil de bascule des abonnements webhook Shopify vers l'URL
// opaque par installation (Lot L3, migration 0143).
// ============================================================================
//
// Deux modes, JAMAIS combinés dans la même invocation :
//   --plan   lecture seule. Interroge l'Admin API de chaque boutique connectée, produit
//            l'inventaire réel des abonnements et le diff attendu. AUCUNE mutation, ni
//            côté Shopify ni côté base — pas même la génération d'un jeton.
//   --apply  mutation, explicite. Remplace un abonnement existant plutôt que d'en ajouter
//            un second ; vérifie par relecture après chaque boutique ; idempotent (une
//            boutique déjà conforme n'est jamais retouchée).
//
// Usage :
//   node scripts/webhook-subscription-migration.mjs --plan
//   node scripts/webhook-subscription-migration.mjs --apply
//
// Env requis (les deux modes) :
//   NEXT_PUBLIC_SUPABASE_URL (ou SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY
//   SHOPIFY_TOKEN_ENCRYPTION_KEY (+ _PREVIOUS optionnel, cf. lib/shopify/crypto.ts)
//   Au moins une paire SHOPIFY_*_API_KEY/SECRET (lib/shopify/apps.ts, mêmes 4 apps)
//   WEBHOOK_PUBLIC_BASE_URL — HTTPS, SANS slash final. Refuse de démarrer si absente ou
//   malformée. Aucune URL de production en dur dans ce fichier.
//
// Topics : cf. ADMIN_API_TOPICS / APP_LEVEL_ONLY_TOPICS ci-dessous. Les trois topics de
// conformité GDPR (customers/data_request, customers/redact, shop/redact) ne sont PAS
// souscriptibles via webhookSubscriptionCreate (confirmé contre l'énumération
// WebhookSubscriptionTopic de l'API Admin, qui ne les liste pas) — ils restent configurés
// au niveau app (Partner Dashboard / TOML) et continuent de router vers l'ancien endpoint
// signé par corps (app/api/shopify/webhooks/route.ts). app/uninstalled EST dans cette
// énumération et bascule donc comme les autres.
//
// Discipline de secret : le jeton d'accès Admin API et le secret webhook généré par ce
// script ne sortent jamais de la mémoire du processus. Toute URL affichée est masquée
// (segment de jeton opaque remplacé par ***). Un garde-fou de l'environnement bloqué
// (permission refusée, classifieur) n'est jamais contourné : ce script s'arrête et
// rapporte, il ne réessaie pas.
//
// Note d'implémentation — pourquoi lib/shopify/token.ts n'est PAS importé directement :
// ce script est exécuté par le Node natif (support TypeScript intégré), pas par le
// résolveur de chemins de Next/tsc — il ne comprend pas l'alias `@/*` (tsconfig.json).
// lib/shopify/token.ts (orchestration decrypt+refresh+persist) importe en interne
// `@/lib/shopify/crypto` et `@/lib/shopify/oauth`, ce qui casse sa résolution ici. Les
// PRIMITIVES qu'il orchestre (lib/shopify/crypto.ts, lib/shopify/oauth.ts,
// lib/shopify/graphql.ts) n'ont, elles, AUCUN import interne aliasé — importées ci-dessous
// SANS modification, exactement comme le reste du dépôt les utilise. `getValidAccessToken`
// plus bas reproduit UNIQUEMENT l'orchestration (vérification d'expiration, persistance du
// nouveau couple) de lib/shopify/token.ts — jamais son contenu cryptographique, qui reste
// entièrement délégué aux fonctions importées.
import { createClient } from '@supabase/supabase-js';
import { SHOPIFY_APP_ENV_KEYS } from '../lib/shopify/app-registry-sources.ts';
import { decryptToken, encryptToken } from '../lib/shopify/crypto.ts';
import { shopifyGraphQL } from '../lib/shopify/graphql.ts';
import { refreshAccessToken } from '../lib/shopify/oauth.ts';
import { ensureWebhookToken } from './lib/webhook-token-provisioning.mjs';

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Miroir de lib/shopify/token.ts::getValidShopAccessToken, réduit à l'orchestration (la
// fonction originale n'est pas importable ici — cf. note ci-dessus). Décrypte/rafraîchit/
// persiste via les MÊMES primitives que le reste du dépôt, jamais une resémantisation.
async function getValidAccessToken(admin, shop, app) {
  if (!shop.access_token_encrypted) {
    return { ok: false, reason: 'needs_reauth' };
  }

  let accessToken;
  try {
    accessToken = decryptToken(shop.access_token_encrypted);
  } catch {
    return { ok: false, reason: 'token_error' };
  }

  const expiresAt = shop.access_token_expires_at ? Date.parse(shop.access_token_expires_at) : null;
  if (expiresAt === null || expiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return { ok: true, accessToken };
  }

  if (!shop.refresh_token_encrypted) {
    return { ok: false, reason: 'needs_reauth' };
  }
  const refreshExpiresAt = shop.refresh_token_expires_at
    ? Date.parse(shop.refresh_token_expires_at)
    : null;
  if (refreshExpiresAt !== null && refreshExpiresAt <= Date.now()) {
    return { ok: false, reason: 'needs_reauth' };
  }

  let refreshToken;
  try {
    refreshToken = decryptToken(shop.refresh_token_encrypted);
  } catch {
    return { ok: false, reason: 'token_error' };
  }

  let refreshed;
  try {
    refreshed = await refreshAccessToken({
      shop: shop.shop_domain,
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      refreshToken,
    });
  } catch {
    return { ok: false, reason: 'needs_reauth' };
  }

  const { data, error } = await admin
    .from('shop')
    .update({
      access_token_encrypted: encryptToken(refreshed.accessToken),
      refresh_token_encrypted: refreshed.refreshToken
        ? encryptToken(refreshed.refreshToken)
        : shop.refresh_token_encrypted,
      access_token_expires_at: refreshed.accessTokenExpiresAt?.toISOString() ?? null,
      refresh_token_expires_at:
        refreshed.refreshTokenExpiresAt?.toISOString() ?? shop.refresh_token_expires_at,
      updated_at: new Date().toISOString(),
    })
    .eq('id', shop.id)
    .eq('access_token_encrypted', shop.access_token_encrypted)
    .select('id')
    .maybeSingle();

  if (error || !data) {
    return { ok: false, reason: 'token_error' };
  }

  return { ok: true, accessToken: refreshed.accessToken };
}

function log(...args) {
  // biome-ignore lint/suspicious/noConsole: script CLI, sa sortie EST le livrable.
  console.log(...args);
}

function logError(...args) {
  // biome-ignore lint/suspicious/noConsole: script CLI, sa sortie EST le livrable.
  console.error(...args);
}

// ── Topics ───────────────────────────────────────────────────────────────────────────────
// rest = forme historique (webhook_event.topic, ingestion_event.topic) ; graphql = valeur de
// l'enum WebhookSubscriptionTopic attendue par webhookSubscriptionCreate/Update.
const ADMIN_API_TOPICS = [
  { rest: 'orders/create', graphql: 'ORDERS_CREATE' },
  { rest: 'orders/updated', graphql: 'ORDERS_UPDATED' },
  { rest: 'orders/cancelled', graphql: 'ORDERS_CANCELLED' },
  { rest: 'orders/fulfilled', graphql: 'ORDERS_FULFILLED' },
  { rest: 'products/create', graphql: 'PRODUCTS_CREATE' },
  { rest: 'products/update', graphql: 'PRODUCTS_UPDATE' },
  { rest: 'refunds/create', graphql: 'REFUNDS_CREATE' },
  { rest: 'bulk_operations/finish', graphql: 'BULK_OPERATIONS_FINISH' },
  { rest: 'app/uninstalled', graphql: 'APP_UNINSTALLED' },
];

// Non souscriptibles par l'Admin API (absents de l'enum WebhookSubscriptionTopic, vérifié
// contre la documentation Shopify avant d'écrire ce script — jamais supposé). Restent
// configurés au niveau app et continuent de router vers l'ancien endpoint signé par corps.
const APP_LEVEL_ONLY_TOPICS = ['customers/data_request', 'customers/redact', 'shop/redact'];

const INGEST_PATH_PREFIX = '/api/shopify/ingest/';

// ── Args ─────────────────────────────────────────────────────────────────────────────────
const wantsPlan = process.argv.includes('--plan');
const wantsApply = process.argv.includes('--apply');

if (wantsPlan === wantsApply) {
  logError(
    'webhook-subscription-migration: usage: node scripts/webhook-subscription-migration.mjs (--plan|--apply) — exactement un des deux.',
  );
  process.exit(1);
}
const mode = wantsPlan ? 'plan' : 'apply';

// ── Env : Supabase ───────────────────────────────────────────────────────────────────────
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  logError(
    'webhook-subscription-migration: NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY requis.',
  );
  process.exit(1);
}

// ── Env : URL publique dédiée ────────────────────────────────────────────────────────────
// Jamais une URL en dur. Refus explicite, jamais un repli silencieux sur une valeur devinée.
const rawBaseUrl = process.env.WEBHOOK_PUBLIC_BASE_URL;
if (!rawBaseUrl) {
  logError(
    'webhook-subscription-migration: WEBHOOK_PUBLIC_BASE_URL requise (HTTPS, sans slash final) — refus de démarrer.',
  );
  process.exit(1);
}
if (rawBaseUrl.endsWith('/')) {
  logError(
    'webhook-subscription-migration: WEBHOOK_PUBLIC_BASE_URL ne doit pas porter de slash final — refus de démarrer.',
  );
  process.exit(1);
}
let baseUrl;
try {
  baseUrl = new URL(rawBaseUrl);
} catch {
  logError(`webhook-subscription-migration: WEBHOOK_PUBLIC_BASE_URL malformée : ${rawBaseUrl}`);
  process.exit(1);
}
if (baseUrl.protocol !== 'https:') {
  logError('webhook-subscription-migration: WEBHOOK_PUBLIC_BASE_URL doit être en HTTPS.');
  process.exit(1);
}

// ── Env : chiffrement des jetons Admin API ──────────────────────────────────────────────
if (!process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY) {
  logError(
    'webhook-subscription-migration: SHOPIFY_TOKEN_ENCRYPTION_KEY requise pour déchiffrer les jetons Admin API des boutiques — refus de démarrer.',
  );
  process.exit(1);
}

// ── Registre d'apps ──────────────────────────────────────────────────────────────────────
// Mêmes 4 apps que lib/shopify/apps.ts, dont la liste {label, clé client_id, clé secret} est
// nommée UNE SEULE FOIS dans lib/shopify/app-registry-sources.ts (pur, zéro import — donc
// importable ici sans le problème d'alias décrit plus haut). Ce qui suit n'est PAS une
// réimplémentation du registre applicatif (createShopifyAppRegistry, lib/shopify/app-registry.ts,
// lui-même non importable ici car il dépend de `@/lib/shopify/oauth`) : c'est une simple table
// de correspondance client_id -> app, sans logique de sécurité — le déchiffrement/HMAC restent
// entièrement délégués aux imports ci-dessus.
const appsByClientId = new Map();
for (const { label, clientIdKey, clientSecretKey } of SHOPIFY_APP_ENV_KEYS) {
  const clientId = process.env[clientIdKey];
  const clientSecret = process.env[clientSecretKey];
  if (clientId && clientSecret) {
    appsByClientId.set(clientId, { label, clientId, clientSecret });
  }
}
if (appsByClientId.size === 0) {
  logError(
    'webhook-subscription-migration: aucune app Shopify configurée (SHOPIFY_*_API_KEY/SECRET manquants) — refus de démarrer.',
  );
  process.exit(1);
}

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── Masquage : tout jeton opaque présent dans une URL est masqué, systématiquement. ────
function maskIngestUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    return '<absente>';
  }
  const idx = rawUrl.indexOf(INGEST_PATH_PREFIX);
  if (idx === -1) {
    // URL qui ne pointe pas vers notre endpoint opaque (ancien endpoint, service tiers…) :
    // rien à masquer, mais on ne montre jamais de query string par prudence.
    try {
      const u = new URL(rawUrl);
      return `${u.origin}${u.pathname}`;
    } catch {
      return '<url non parseable>';
    }
  }
  return `${rawUrl.slice(0, idx)}${INGEST_PATH_PREFIX}***`;
}

function targetUrl(publicId, secret) {
  return `${rawBaseUrl}${INGEST_PATH_PREFIX}${publicId}.${secret}`;
}

// ── Chargement des connexions actives + boutiques + jetons existants ───────────────────
async function fetchAll(table, select, filter) {
  const rows = [];
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    let query = admin
      .from(table)
      .select(select)
      .range(from, from + pageSize - 1);
    if (filter) query = filter(query);
    const { data, error } = await query;
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function loadState() {
  const connections = await fetchAll(
    'store_connection',
    'id, merchant_account_id, shop_id, external_identifier, platform_app_id, status',
    (q) => q.eq('platform', 'shopify').eq('status', 'active'),
  );

  const shopIds = connections.map((c) => c.shop_id);
  const shops =
    shopIds.length === 0
      ? []
      : await fetchAll(
          'shop',
          'id, shop_domain, shopify_client_id, access_token_encrypted, refresh_token_encrypted, access_token_expires_at, refresh_token_expires_at',
          (q) => q.in('id', shopIds),
        );
  const shopById = new Map(shops.map((s) => [s.id, s]));

  const connectionIds = connections.map((c) => c.id);
  const tokens =
    connectionIds.length === 0
      ? []
      : await fetchAll(
          'store_connection_webhook_token',
          'store_connection_id, public_id, revoked_at',
          (q) => q.in('store_connection_id', connectionIds),
        );
  const tokenByConnection = new Map(tokens.map((t) => [t.store_connection_id, t]));

  return { connections, shopById, tokenByConnection };
}

// ── Admin API ────────────────────────────────────────────────────────────────────────────
const WEBHOOK_SUBSCRIPTIONS_QUERY = `#graphql
  query WebhookSubscriptionsInventory($first: Int!) {
    webhookSubscriptions(first: $first) {
      edges {
        node {
          id
          topic
          format
          endpoint {
            __typename
            ... on WebhookHttpEndpoint { callbackUrl }
          }
        }
      }
    }
  }
`;

const WEBHOOK_SUBSCRIPTION_CREATE = `#graphql
  mutation WebhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      webhookSubscription { id topic }
      userErrors { field message }
    }
  }
`;

const WEBHOOK_SUBSCRIPTION_UPDATE = `#graphql
  mutation WebhookSubscriptionUpdate($id: ID!, $webhookSubscription: WebhookSubscriptionInput!) {
    webhookSubscriptionUpdate(id: $id, webhookSubscription: $webhookSubscription) {
      webhookSubscription { id topic }
      userErrors { field message }
    }
  }
`;

const WEBHOOK_SUBSCRIPTION_DELETE = `#graphql
  mutation WebhookSubscriptionDelete($id: ID!) {
    webhookSubscriptionDelete(id: $id) {
      deletedWebhookSubscriptionId
      userErrors { field message }
    }
  }
`;

async function listSubscriptions(shopDomain, accessToken) {
  const data = await shopifyGraphQL({
    shopDomain,
    accessToken,
    query: WEBHOOK_SUBSCRIPTIONS_QUERY,
    variables: { first: 250 },
  });
  return data.webhookSubscriptions.edges.map((e) => e.node);
}

function subscriptionsByGraphqlTopic(subscriptions) {
  const map = new Map();
  for (const sub of subscriptions) {
    const list = map.get(sub.topic) ?? [];
    list.push(sub);
    map.set(sub.topic, list);
  }
  return map;
}

// Décide l'action pour UN topic Admin-API-souscriptible d'UNE boutique, à partir de
// l'inventaire réel et du jeton local connu (jamais son secret — seul public_id est comparé,
// stocké en clair, cf. 0143). Ne calcule QUE le diagnostic ; aucune mutation ici.
function planTopicAction({ existingForTopic, knownPublicId, ourOrigin }) {
  if (existingForTopic.length > 1) {
    return {
      action: 'anomalie_multiple',
      detail: `${existingForTopic.length} abonnements actifs simultanés sur ce topic (invariant violé) — résolution manuelle requise, jamais automatique.`,
    };
  }

  if (existingForTopic.length === 0) {
    return { action: 'creer', detail: 'aucun abonnement existant sur ce topic.' };
  }

  const sub = existingForTopic[0];
  const endpoint = sub.endpoint;

  if (endpoint?.__typename !== 'WebhookHttpEndpoint' || !endpoint.callbackUrl) {
    return {
      action: 'remplacer',
      detail: `endpoint non-HTTP ou illisible (${endpoint?.__typename ?? 'inconnu'}) — remplacé par l'URL opaque.`,
      existingId: sub.id,
    };
  }

  let existingUrl;
  try {
    existingUrl = new URL(endpoint.callbackUrl);
  } catch {
    return {
      action: 'remplacer',
      detail: `callbackUrl illisible (${maskIngestUrl(endpoint.callbackUrl)}).`,
      existingId: sub.id,
    };
  }

  if (existingUrl.origin !== ourOrigin || !existingUrl.pathname.startsWith(INGEST_PATH_PREFIX)) {
    return {
      action: 'remplacer',
      detail: `pointe ailleurs (${maskIngestUrl(endpoint.callbackUrl)}) — probablement l'ancien endpoint ou une configuration de test.`,
      existingId: sub.id,
    };
  }

  const tokenSegment = existingUrl.pathname.slice(INGEST_PATH_PREFIX.length);
  const existingPublicId = tokenSegment.split('.')[0];

  if (!knownPublicId) {
    return {
      action: 'anomalie_token_local_absent',
      detail:
        "Shopify pointe déjà vers l'URL opaque mais aucun jeton local n'existe pour cette connexion — état incohérent, résolution manuelle requise.",
      existingId: sub.id,
    };
  }

  if (existingPublicId === knownPublicId) {
    return { action: 'conforme', detail: 'abonnement déjà aligné sur le jeton actuel.' };
  }

  return {
    action: 'remplacer',
    detail: 'abonnement pointe vers un jeton différent (rotation antérieure jamais propagée).',
    existingId: sub.id,
  };
}

async function planConnection({ connection, shop, app, knownToken }) {
  const rows = [];
  const tokenResult = await getValidAccessToken(admin, shop, app);

  if (!tokenResult.ok) {
    return {
      connection,
      shop,
      app,
      blocked: true,
      reason: tokenResult.reason,
      topics: [],
    };
  }

  const subscriptions = await listSubscriptions(shop.shop_domain, tokenResult.accessToken);
  const byTopic = subscriptionsByGraphqlTopic(subscriptions);
  const ourOrigin = baseUrl.origin;
  const knownPublicId = knownToken && !knownToken.revoked_at ? knownToken.public_id : null;

  for (const topic of ADMIN_API_TOPICS) {
    const existingForTopic = byTopic.get(topic.graphql) ?? [];
    const result = planTopicAction({ existingForTopic, knownPublicId, ourOrigin });
    rows.push({ topic: topic.rest, graphqlTopic: topic.graphql, ...result });
  }

  for (const topic of APP_LEVEL_ONLY_TOPICS) {
    rows.push({
      topic,
      graphqlTopic: null,
      action: 'non_applicable',
      detail:
        "non souscriptible via l'Admin API (absent de l'enum WebhookSubscriptionTopic) — reste sur l'ancien endpoint, identité par corps signé.",
    });
  }

  // Inventaire complet (colonnes exactes demandées), tous topics confondus — pas seulement
  // les 9 ciblés, pour donner une visibilité réelle sur ce que Shopify sait de cette boutique.
  const inventory = subscriptions.map((sub) => ({
    topic: sub.topic,
    subscriptionId: sub.id,
    endpointType: sub.endpoint?.__typename ?? 'inconnu',
    callbackUrl: maskIngestUrl(sub.endpoint?.callbackUrl),
  }));

  return { connection, shop, app, blocked: false, topics: rows, inventory, tokenResult };
}

function printPlanReport(results) {
  log('=== webhook-subscription-migration --plan ===');
  log(`Boutiques Shopify actives évaluées : ${results.length}`);
  log('');

  for (const r of results) {
    log(`— ${r.shop.shop_domain} (app=${r.app.label}, connexion=${r.connection.id})`);
    if (r.blocked) {
      log(`  BLOQUÉ : jeton Admin API indisponible (${r.reason}) — ignorée pour ce run.`);
      log('');
      continue;
    }

    log(`  Inventaire réel (${r.inventory.length} abonnement(s), tous topics) :`);
    for (const inv of r.inventory) {
      log(
        `    ${inv.topic.padEnd(28)} id=${inv.subscriptionId} ${inv.endpointType} ${inv.callbackUrl}`,
      );
    }

    log('  Diff attendu (9 topics Admin-API + 3 hors périmètre) :');
    for (const t of r.topics) {
      log(`    ${t.topic.padEnd(28)} -> ${t.action.padEnd(26)} ${t.detail}`);
    }
    log('');
  }

  const totals = new Map();
  for (const r of results) {
    if (r.blocked) continue;
    for (const t of r.topics) {
      totals.set(t.action, (totals.get(t.action) ?? 0) + 1);
    }
  }
  log('Totaux par action, toutes boutiques confondues :');
  for (const [action, count] of totals) {
    log(`  ${action.padEnd(26)} ${count}`);
  }

  const blockedCount = results.filter((r) => r.blocked).length;
  const anomalies = results
    .filter((r) => !r.blocked)
    .flatMap((r) => r.topics.filter((t) => t.action.startsWith('anomalie')));

  if (blockedCount > 0 || anomalies.length > 0) {
    log('');
    log(
      `ATTENTION : ${blockedCount} boutique(s) bloquée(s) et ${anomalies.length} anomalie(s) — --apply s'arrêtera sur ces cas sans les résoudre automatiquement.`,
    );
  }
}

// ── --apply ──────────────────────────────────────────────────────────────────────────────
async function applyConnection(planned) {
  if (planned.blocked) {
    return { shopDomain: planned.shop.shop_domain, ok: false, reason: `bloqué: ${planned.reason}` };
  }

  const actionable = planned.topics.filter((t) => t.action === 'creer' || t.action === 'remplacer');
  const blocking = planned.topics.filter((t) => t.action.startsWith('anomalie'));

  if (blocking.length > 0) {
    return {
      shopDomain: planned.shop.shop_domain,
      ok: false,
      reason: `${blocking.length} anomalie(s) non résolue(s) automatiquement — ${blocking.map((b) => `${b.topic}: ${b.detail}`).join(' | ')}`,
    };
  }

  if (actionable.length === 0) {
    return {
      shopDomain: planned.shop.shop_domain,
      ok: true,
      changed: false,
      detail: 'déjà conforme.',
    };
  }

  // Un seul jeton généré/tourné par boutique pour toute cette passe (jamais un par topic) —
  // le secret en clair ne vit que dans cette fonction, jamais loggé, jamais renvoyé au-delà.
  const { publicId, secret } = await ensureWebhookToken(admin, planned.connection.id);
  const url = targetUrl(publicId, secret);
  const input = { callbackUrl: url, format: 'JSON' };

  const changes = [];
  for (const t of actionable) {
    if (t.action === 'creer') {
      const data = await shopifyGraphQL({
        shopDomain: planned.shop.shop_domain,
        accessToken: planned.tokenResult.accessToken,
        query: WEBHOOK_SUBSCRIPTION_CREATE,
        variables: { topic: t.graphqlTopic, webhookSubscription: input },
      });
      const errors = data.webhookSubscriptionCreate.userErrors;
      if (errors.length > 0) {
        changes.push({
          topic: t.topic,
          ok: false,
          detail: errors.map((e) => e.message).join('; '),
        });
        continue;
      }
      changes.push({ topic: t.topic, ok: true, mutation: 'create' });
    } else {
      const data = await shopifyGraphQL({
        shopDomain: planned.shop.shop_domain,
        accessToken: planned.tokenResult.accessToken,
        query: WEBHOOK_SUBSCRIPTION_UPDATE,
        variables: { id: t.existingId, webhookSubscription: input },
      });
      const errors = data.webhookSubscriptionUpdate.userErrors;
      if (errors.length > 0) {
        changes.push({
          topic: t.topic,
          ok: false,
          detail: errors.map((e) => e.message).join('; '),
        });
        continue;
      }
      changes.push({ topic: t.topic, ok: true, mutation: 'update' });
    }
  }

  // Vérification finale par relecture — jamais une confiance aveugle dans le retour de la
  // mutation. Un abonnement dupliqué détecté ici (ne devrait jamais arriver avec update, mais
  // vérifié plutôt que supposé) est supprimé explicitement : remplacer, jamais ajouter.
  const freshSubscriptions = await listSubscriptions(
    planned.shop.shop_domain,
    planned.tokenResult.accessToken,
  );
  const freshByTopic = subscriptionsByGraphqlTopic(freshSubscriptions);
  const verification = [];

  for (const t of actionable) {
    const list = freshByTopic.get(t.graphqlTopic) ?? [];
    const matching = list.filter((sub) => {
      const cb = sub.endpoint?.callbackUrl;
      if (!cb) return false;
      try {
        const u = new URL(cb);
        return (
          u.pathname.startsWith(INGEST_PATH_PREFIX) &&
          u.pathname.slice(INGEST_PATH_PREFIX.length).split('.')[0] === publicId
        );
      } catch {
        return false;
      }
    });

    if (matching.length !== 1) {
      verification.push({
        topic: t.topic,
        ok: false,
        detail: `relecture : ${matching.length} abonnement(s) trouvé(s) pointant vers le jeton courant (attendu 1).`,
      });
      continue;
    }

    const stale = list.filter((sub) => sub.id !== matching[0].id);
    for (const staleSub of stale) {
      const del = await shopifyGraphQL({
        shopDomain: planned.shop.shop_domain,
        accessToken: planned.tokenResult.accessToken,
        query: WEBHOOK_SUBSCRIPTION_DELETE,
        variables: { id: staleSub.id },
      });
      const errors = del.webhookSubscriptionDelete.userErrors;
      verification.push({
        topic: t.topic,
        ok: errors.length === 0,
        detail:
          errors.length === 0
            ? `abonnement périmé (${staleSub.id}) retiré après relecture.`
            : `échec de retrait de l'abonnement périmé (${staleSub.id}) : ${errors.map((e) => e.message).join('; ')}`,
      });
    }

    verification.push({
      topic: t.topic,
      ok: true,
      detail: 'relecture confirmée : un seul abonnement, jeton courant.',
    });
  }

  const allOk = changes.every((c) => c.ok) && verification.every((v) => v.ok);

  return {
    shopDomain: planned.shop.shop_domain,
    ok: allOk,
    changed: true,
    changes,
    verification,
  };
}

function printApplyReport(results) {
  log('=== webhook-subscription-migration --apply ===');
  for (const r of results) {
    log(`— ${r.shopDomain}`);
    if (!r.ok && !r.changed) {
      log(`  ÉCHEC : ${r.reason}`);
      continue;
    }
    if (!r.changed) {
      log(`  ${r.detail}`);
      continue;
    }
    for (const c of r.changes) {
      log(`  mutation ${c.mutation ?? '?'} topic=${c.topic} ${c.ok ? 'OK' : `ÉCHEC: ${c.detail}`}`);
    }
    for (const v of r.verification) {
      log(`  relecture topic=${v.topic} ${v.ok ? 'OK' : `ÉCHEC: ${v.detail}`} — ${v.detail}`);
    }
    log(`  résultat : ${r.ok ? 'validée' : 'NON VALIDÉE — voir échecs ci-dessus'}`);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    logError(`webhook-subscription-migration: ${failed.length} boutique(s) non validée(s).`);
  }
  return failed.length;
}

// ── main ─────────────────────────────────────────────────────────────────────────────────
async function main() {
  const { connections, shopById, tokenByConnection } = await loadState();

  if (connections.length === 0) {
    log('webhook-subscription-migration: aucune store_connection Shopify active — rien à faire.');
    process.exit(0);
  }

  const planned = [];
  for (const connection of connections) {
    const shop = shopById.get(connection.shop_id);
    if (!shop) {
      planned.push({
        connection,
        shop: { shop_domain: `<shop introuvable id=${connection.shop_id}>` },
        app: { label: '?' },
        blocked: true,
        reason: 'shop_introuvable',
        topics: [],
      });
      continue;
    }
    const app = shop.shopify_client_id
      ? (appsByClientId.get(shop.shopify_client_id) ?? null)
      : null;
    if (!app) {
      planned.push({
        connection,
        shop,
        app: { label: `client_id inconnu (${shop.shopify_client_id ?? 'null'})` },
        blocked: true,
        reason: 'app_inconnue',
        topics: [],
      });
      continue;
    }
    const knownToken = tokenByConnection.get(connection.id) ?? null;
    const result = await planConnection({ connection, shop, app, knownToken });
    planned.push(result);
  }

  if (mode === 'plan') {
    printPlanReport(planned);
    process.exit(0);
  }

  const applyResults = [];
  for (const p of planned) {
    const result = await applyConnection(p);
    applyResults.push(result);
  }
  const failedCount = printApplyReport(applyResults);
  process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((error) => {
  logError('webhook-subscription-migration: échec', error);
  process.exit(1);
});
