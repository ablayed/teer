// Phase 2 — Clôture : logique de décision PURE (aucun import Supabase, aucun appel réseau) du
// bascule des abonnements webhook Shopify. Extraite de webhook-subscription-migration.mjs pour
// être unit-testable — en particulier l'invariant d'idempotence de --apply : un jeton EXISTANT
// n'est jamais touché par un simple --apply, jamais en effet de bord d'une mutation par ailleurs
// nécessaire. Voir tests/unit/shopify/webhook-subscription-plan.test.ts.

// rest = forme historique (webhook_event.topic, ingestion_event.topic) ; graphql = valeur de
// l'enum WebhookSubscriptionTopic attendue par webhookSubscriptionCreate/Update.
export const ADMIN_API_TOPICS = [
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
export const APP_LEVEL_ONLY_TOPICS = ['customers/data_request', 'customers/redact', 'shop/redact'];

export const INGEST_PATH_PREFIX = '/api/shopify/ingest/';
const OPAQUE_INGEST_SEGMENT = /\/api\/shopify\/ingest\/[^\s"'`),;]+/g;

const CANONICAL_SHOP_DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/;

export function validateShopDomainSelection(rawDomain) {
  if (typeof rawDomain !== 'string' || rawDomain.length === 0) {
    return { ok: false, reason: 'shop_domain_required' };
  }

  if (!CANONICAL_SHOP_DOMAIN.test(rawDomain)) {
    return { ok: false, reason: 'shop_domain_must_be_canonical' };
  }

  return { ok: true, shopDomain: rawDomain };
}

export function resolveSingleShopSelection(shops, shopDomain) {
  const matches = shops.filter((shop) => shop.shop_domain === shopDomain);
  if (matches.length === 0) {
    return { ok: false, reason: 'shop_not_found' };
  }
  if (matches.length > 1) {
    return { ok: false, reason: 'shop_domain_ambiguous' };
  }
  return { ok: true, shop: matches[0] };
}

export function resolveSingleConnectionSelection(connections) {
  if (connections.length === 0) {
    return { ok: false, reason: 'shop_connection_not_found' };
  }
  if (connections.length > 1) {
    return { ok: false, reason: 'shop_connection_ambiguous' };
  }
  return { ok: true, connection: connections[0] };
}

export function accessTokenNeedsRenewal(
  expiresAt,
  now = Date.now(),
  refreshBufferMs = 5 * 60 * 1000,
) {
  if (expiresAt === null || expiresAt === undefined) {
    return false;
  }
  const timestamp = Date.parse(expiresAt);
  return !Number.isFinite(timestamp) || timestamp - now <= refreshBufferMs;
}

export function resolvePlanAccessToken({
  encryptedToken,
  expiresAt,
  decrypt,
  now = Date.now(),
  refreshBufferMs,
}) {
  if (!encryptedToken) {
    return { ok: false, reason: 'needs_reauth' };
  }

  let accessToken;
  try {
    accessToken = decrypt(encryptedToken);
  } catch {
    return { ok: false, reason: 'token_error' };
  }

  if (accessTokenNeedsRenewal(expiresAt, now, refreshBufferMs)) {
    return { ok: false, reason: 'renewal_required' };
  }

  return { ok: true, accessToken };
}

export async function resolveAccessTokenForMode({
  mode,
  shop,
  app,
  decrypt,
  refresh,
  persistRefreshedToken,
  now = Date.now(),
  refreshBufferMs,
}) {
  if (mode === 'plan') {
    return resolvePlanAccessToken({
      encryptedToken: shop.access_token_encrypted,
      expiresAt: shop.access_token_expires_at,
      decrypt,
      now,
      refreshBufferMs,
    });
  }

  if (!shop.access_token_encrypted) {
    return { ok: false, reason: 'needs_reauth' };
  }

  let accessToken;
  try {
    accessToken = decrypt(shop.access_token_encrypted);
  } catch {
    return { ok: false, reason: 'token_error' };
  }

  if (!accessTokenNeedsRenewal(shop.access_token_expires_at, now, refreshBufferMs)) {
    return { ok: true, accessToken };
  }

  if (!shop.refresh_token_encrypted) {
    return { ok: false, reason: 'needs_reauth' };
  }
  const refreshExpiresAt = shop.refresh_token_expires_at
    ? Date.parse(shop.refresh_token_expires_at)
    : null;
  if (refreshExpiresAt !== null && refreshExpiresAt <= now) {
    return { ok: false, reason: 'needs_reauth' };
  }

  let refreshToken;
  try {
    refreshToken = decrypt(shop.refresh_token_encrypted);
  } catch {
    return { ok: false, reason: 'token_error' };
  }

  let refreshed;
  try {
    refreshed = await refresh({
      shop: shop.shop_domain,
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      refreshToken,
    });
  } catch {
    return { ok: false, reason: 'needs_reauth' };
  }

  const persisted = await persistRefreshedToken({ refreshed, shop });
  if (!persisted.ok) {
    return { ok: false, reason: 'token_error' };
  }

  return { ok: true, accessToken: refreshed.accessToken };
}

export function scopeShopQuery(query, shopDomain) {
  return query.eq('shop_domain', shopDomain);
}

export function scopeActiveConnectionQuery(query, shopId) {
  return query.eq('platform', 'shopify').eq('status', 'active').eq('shop_id', shopId);
}

function serializeErrorShape(error, seen = new WeakSet()) {
  if (error === null || typeof error !== 'object') {
    return error;
  }
  if (seen.has(error)) {
    return '[circular]';
  }
  seen.add(error);

  const shape = {};
  for (const key of Object.getOwnPropertyNames(error)) {
    shape[key] = serializeErrorShape(error[key], seen);
  }
  if (!Object.hasOwn(shape, 'name')) shape.name = error.name;
  if (!Object.hasOwn(shape, 'message')) shape.message = error.message;
  if (error.cause !== undefined && !Object.hasOwn(shape, 'cause')) {
    shape.cause = serializeErrorShape(error.cause, seen);
  }
  return shape;
}

export function controlledErrorMessage(error) {
  // Serialize the complete error shape for classification, but never return it. Error values can
  // contain access tokens, opaque webhook URLs, or provider response details.
  const shape = serializeErrorShape(error);
  const name =
    shape && typeof shape === 'object' && typeof shape.name === 'string' ? shape.name : '';
  const knownKinds = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError']);
  return `cause=${knownKinds.has(name) ? name.toLowerCase() : 'maintenance_failure'}`;
}

export function maskSensitiveText(value) {
  return typeof value === 'string'
    ? value.replace(OPAQUE_INGEST_SEGMENT, `${INGEST_PATH_PREFIX}***`)
    : value;
}

// ── Masquage : tout jeton opaque présent dans une URL est masqué, systématiquement. ────
export function maskIngestUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    return '<absente>';
  }
  const idx = rawUrl.indexOf(INGEST_PATH_PREFIX);
  if (idx === -1) {
    try {
      const u = new URL(rawUrl);
      return `${u.origin}${u.pathname}`;
    } catch {
      return '<url non parseable>';
    }
  }
  return `${rawUrl.slice(0, idx)}${INGEST_PATH_PREFIX}***`;
}

export function subscriptionsByGraphqlTopic(subscriptions) {
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
//
// `existingId` est TOUJOURS renvoyé quand une souscription existe (y compris 'conforme') : c'est
// ce qui permet de vérifier, à un second passage, que l'identifiant Shopify n'a pas changé
// (invariant d'idempotence #3 — cf. rapport de session).
export function planTopicAction({ existingForTopic, knownPublicId, ourOrigin }) {
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
    return {
      action: 'conforme',
      detail: 'abonnement déjà aligné sur le jeton actuel.',
      existingId: sub.id,
    };
  }

  return {
    action: 'remplacer',
    detail: 'abonnement pointe vers un jeton différent (rotation antérieure jamais propagée).',
    existingId: sub.id,
  };
}

// Décide l'action GLOBALE pour une connexion, à partir du diagnostic par topic + de la présence
// d'un jeton local. PURE — aucun appel réseau, aucune mutation. C'est CETTE fonction qui porte
// l'invariant central : un jeton EXISTANT n'entraîne jamais de rotation implicite.
//
//   'blocked_anomalie'   — au moins une anomalie non résolue automatiquement ; rien n'est touché.
//   'already_conformant' — aucun topic actionnable ; --apply ne fait STRICTEMENT rien (les 3
//                          invariants — jeton, URL cible, id d'abonnement — restent inchangés
//                          par construction, puisqu'aucune mutation n'est même tentée).
//   'requires_rotation'  — des topics sont actionnables MAIS un jeton local existe déjà : le
//                          construire nécessiterait de faire tourner un secret déjà en usage par
//                          d'autres topics potentiellement conformes → --apply refuse de toucher
//                          cette connexion, --rotate-token est requis explicitement.
//   'provision'          — des topics sont actionnables et AUCUN jeton local n'existe encore :
//                          première provision, sans risque d'invalider une URL déjà enregistrée.
export function decideConnectionApplyPlan({ topics, hasLocalToken }) {
  const actionable = topics.filter((t) => t.action === 'creer' || t.action === 'remplacer');
  const blocking = topics.filter((t) => t.action.startsWith('anomalie'));

  if (blocking.length > 0) {
    return { kind: 'blocked_anomalie', blocking, actionable };
  }

  if (actionable.length === 0) {
    return { kind: 'already_conformant', topics };
  }

  if (hasLocalToken) {
    return { kind: 'requires_rotation', actionable };
  }

  return { kind: 'provision', actionable };
}
