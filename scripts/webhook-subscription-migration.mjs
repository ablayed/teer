#!/usr/bin/env node
import { SHOPIFY_APP_ENV_KEYS } from '../lib/shopify/app-registry-sources.ts';
import { decryptToken, encryptToken } from '../lib/shopify/crypto.ts';
import { shopifyGraphQL } from '../lib/shopify/graphql.ts';
import { refreshAccessToken } from '../lib/shopify/oauth.ts';
// ============================================================================
// Phase 2 — Clôture : outil de bascule des abonnements webhook Shopify vers l'URL
// opaque par installation (Lot L3, migration 0143).
// ============================================================================
//
// Trois modes, JAMAIS combinés dans la même invocation :
//   --plan --shop-domain <domaine> lecture seule. Interroge l'Admin API de la boutique sélectionnée
//                                 connectée, produit l'inventaire réel et le diff attendu.
//                                 AUCUNE mutation, ni côté Shopify ni côté base — pas même la
//                                 génération d'un jeton.
//   --apply                      mutation, explicite, mais NE TOURNE JAMAIS un jeton existant.
//                                 Provisionne un jeton UNIQUEMENT pour une connexion qui n'en a
//                                 encore aucun (première bascule) ; remplace un abonnement
//                                 existant plutôt que d'en ajouter un second ; vérifie par
//                                 relecture ; idempotent (cf. section « idempotence » ci-dessous).
//                                 Une connexion dont le jeton existe déjà et qui a besoin d'une
//                                 mutation est SIGNALÉE, jamais touchée — --rotate-token est requis.
//   --rotate-token <connection>  fait tourner le secret d'UNE connexion (même public_id, ancien
//                                 secret accepté durant la fenêtre de grâce, cf.
//                                 scripts/lib/webhook-token-provisioning.mjs) ET RE-ENREGISTRE LES
//                                 9 TOPICS EN UNE SEULE PASSE, synchrone, avant de rendre la main —
//                                 jamais étalé sur plusieurs exécutions futures. C'est la seule
//                                 opération qui invalide des URL déjà enregistrées côté Shopify ;
//                                 elle est donc explicite et jamais un effet de bord de --apply.
//
// Usage :
//   node scripts/webhook-subscription-migration.mjs --plan --shop-domain boutique.myshopify.com
//   node scripts/webhook-subscription-migration.mjs --apply --shop-domain boutique.myshopify.com
//   node scripts/webhook-subscription-migration.mjs --rotate-token <store_connection_id> --shop-domain boutique.myshopify.com
//
// ── Idempotence de --apply (corrige un défaut trouvé en revue, cf. rapport de session) ────
// La version précédente de cet outil appelait un helper qui FAISAIT TOURNER le secret dès qu'une
// ligne de jeton existait déjà, à chaque fois qu'AU MOINS UN topic nécessitait une mutation — même
// si ce topic était le seul non conforme sur 9. Le secret fait partie de l'URL enregistrée côté
// Shopify (public_id.secret) : une rotation invalide donc TOUTES les URL déjà enregistrées pour
// les topics par ailleurs conformes de la même connexion, y compris ceux que ce run ne
// re-enregistrait pas — un second passage, censé être sûr à rejouer, aurait donc pu couper
// l'ingestion en silence. Fixé : --apply ne crée un jeton QUE pour une connexion qui n'en a
// ENCORE AUCUN (scripts/lib/webhook-subscription-plan.mjs::decideConnectionApplyPlan, 'provision')
// ; toute connexion dont le jeton existe déjà et qui a des topics actionnables tombe en
// 'requires_rotation' — SIGNALÉE, JAMAIS mutée automatiquement. Deux --apply consécutifs sur le
// même état laissent donc structurellement inchangés (prouvé, pas supposé — cf.
// tests/unit/shopify/webhook-subscription-plan.test.ts) : le jeton (aucune mutation tentée en
// 'already_conformant'), l'URL cible de chaque abonnement (idem), et l'identifiant Shopify de
// chaque abonnement (idem — 'conforme' ne mute jamais).
//
// Env requis (les trois modes) :
//   NEXT_PUBLIC_SUPABASE_URL (ou SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY
//   SHOPIFY_TOKEN_ENCRYPTION_KEY (+ _PREVIOUS optionnel, cf. lib/shopify/crypto.ts)
//   Au moins une paire SHOPIFY_*_API_KEY/SECRET (lib/shopify/apps.ts, mêmes 4 apps)
//   WEBHOOK_PUBLIC_BASE_URL — HTTPS, SANS slash final. Refuse de démarrer si absente ou
//   malformée. Aucune URL de production en dur dans ce fichier.
//   --shop-domain — domaine canonique *.myshopify.com obligatoire pour les trois modes.
//
// Topics : cf. scripts/lib/webhook-subscription-plan.mjs. Les trois topics de conformité GDPR
// (customers/data_request, customers/redact, shop/redact) ne sont PAS souscriptibles via
// webhookSubscriptionCreate (confirmé contre l'énumération WebhookSubscriptionTopic de l'API
// Admin, qui ne les liste pas) — ils restent configurés au niveau app (Partner Dashboard / TOML)
// et continuent de router vers l'ancien endpoint signé par corps
// (app/api/shopify/webhooks/route.ts). app/uninstalled EST dans cette énumération et bascule donc
// comme les autres — traité sur le nouvel endpoint (app/api/shopify/ingest/[token]/route.ts,
// cf. rapport de session pour le correctif dédié).
//
// Discipline de secret : le jeton d'accès Admin API et le secret webhook généré par ce script ne
// sortent jamais de la mémoire du processus. Toute URL affichée est masquée (segment de jeton
// opaque remplacé par ***). Un garde-fou de l'environnement bloqué (permission refusée,
// classifieur) n'est jamais contourné : ce script s'arrête et rapporte, il ne réessaie pas.
//
// Note d'implémentation — pourquoi lib/shopify/token.ts n'est PAS importé directement : ce script
// est exécuté par le Node natif (support TypeScript intégré), pas par le résolveur de chemins de
// Next/tsc — il ne comprend pas l'alias `@/*` (tsconfig.json). lib/shopify/token.ts
// (orchestration decrypt+refresh+persist) importe en interne `@/lib/shopify/crypto` et
// `@/lib/shopify/oauth`, ce qui casse sa résolution ici. Les PRIMITIVES qu'il orchestre
// (lib/shopify/crypto.ts, lib/shopify/oauth.ts, lib/shopify/graphql.ts) n'ont, elles, AUCUN
// import interne aliasé — importées ci-dessous SANS modification, exactement comme le reste du
// dépôt les utilise. `getValidAccessToken` plus bas reproduit UNIQUEMENT l'orchestration
// (vérification d'expiration, persistance du nouveau couple) de lib/shopify/token.ts — jamais son
// contenu cryptographique, qui reste entièrement délégué aux fonctions importées.
import { createMaintenanceSupabaseClient } from './lib/maintenance-supabase-client.mjs';
import {
  ADMIN_API_TOPICS,
  APP_LEVEL_ONLY_TOPICS,
  INGEST_PATH_PREFIX,
  controlledErrorMessage,
  decideConnectionApplyPlan,
  maskIngestUrl,
  maskSensitiveText,
  planTopicAction,
  resolveAccessTokenForMode,
  resolveSingleConnectionSelection,
  resolveSingleShopSelection,
  scopeActiveConnectionQuery,
  scopeShopQuery,
  subscriptionsByGraphqlTopic,
  validateShopDomainSelection,
} from './lib/webhook-subscription-plan.mjs';
import {
  createWebhookToken,
  getWebhookToken,
  rotateWebhookToken,
} from './lib/webhook-token-provisioning.mjs';

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Miroir de lib/shopify/token.ts::getValidShopAccessToken, réduit à l'orchestration (la
// fonction originale n'est pas importable ici — cf. note ci-dessus). Décrypte/rafraîchit/
// persiste via les MÊMES primitives que le reste du dépôt, jamais une resémantisation.
async function getValidAccessToken(admin, shop, app) {
  return resolveAccessTokenForMode({
    mode: 'apply',
    shop,
    app,
    decrypt: decryptToken,
    refresh: refreshAccessToken,
    refreshBufferMs: REFRESH_BUFFER_MS,
    persistRefreshedToken: async ({ refreshed }) => {
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
      return { ok: Boolean(data && !error) };
    },
  });
}

function getPlanAccessToken(shop) {
  return resolveAccessTokenForMode({
    mode: 'plan',
    shop,
    decrypt: decryptToken,
    refreshBufferMs: REFRESH_BUFFER_MS,
  });
}

function log(...args) {
  // biome-ignore lint/suspicious/noConsole: script CLI, sa sortie EST le livrable.
  console.log(...args);
}

function logError(...args) {
  // biome-ignore lint/suspicious/noConsole: script CLI, sa sortie EST le livrable.
  console.error(...args);
}

// ── Args ─────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const wantsPlan = argv.includes('--plan');
const wantsApply = argv.includes('--apply');
const rotateFlagIndex = argv.indexOf('--rotate-token');
const wantsRotate = rotateFlagIndex !== -1;
const rotateConnectionId = wantsRotate ? argv[rotateFlagIndex + 1] : null;
const shopDomainFlagIndex = argv.indexOf('--shop-domain');
const rawShopDomain = shopDomainFlagIndex === -1 ? null : argv[shopDomainFlagIndex + 1];

const modesRequested = [wantsPlan, wantsApply, wantsRotate].filter(Boolean).length;
if (modesRequested !== 1) {
  logError(
    'webhook-subscription-migration: usage: node scripts/webhook-subscription-migration.mjs (--plan|--apply|--rotate-token <connection_id>) --shop-domain <canonical.myshopify.com> — exactement un mode et un domaine.',
  );
  process.exit(1);
}
if (wantsRotate && (!rotateConnectionId || rotateConnectionId.startsWith('--'))) {
  logError(
    'webhook-subscription-migration: --rotate-token requiert un store_connection_id en argument suivant.',
  );
  process.exit(1);
}
const shopDomainSelection = validateShopDomainSelection(rawShopDomain);
if (!shopDomainSelection.ok) {
  logError(`webhook-subscription-migration: ${shopDomainSelection.reason}.`);
  process.exit(1);
}
const selectedShopDomain = shopDomainSelection.shopDomain;
const mode = wantsPlan ? 'plan' : wantsApply ? 'apply' : 'rotate';

// ── Env : Supabase ───────────────────────────────────────────────────────────────────────
const supabaseUrl = process.env.WEBHOOK_MIGRATION_SUPABASE_URL;
const serviceRoleKey = process.env.WEBHOOK_MIGRATION_SUPABASE_SERVICE_ROLE_KEY;
const allowedTarget = process.env.WEBHOOK_MIGRATION_SUPABASE_ALLOWED_ORIGIN;

if (!supabaseUrl || !serviceRoleKey) {
  logError('webhook-subscription-migration: configuration de maintenance dédiée requise.');
  process.exit(1);
}

const admin = createMaintenanceSupabaseClient({
  target: supabaseUrl,
  variableName: 'WEBHOOK_MIGRATION_SUPABASE_URL',
  serviceRoleKey,
  allowedTarget,
  allowedVariableName: 'WEBHOOK_MIGRATION_SUPABASE_ALLOWED_ORIGIN',
});

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
  logError('webhook-subscription-migration: WEBHOOK_PUBLIC_BASE_URL malformée.');
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

async function loadSelectedShop(shopDomain) {
  const candidates = await fetchAll('shop', 'id, shop_domain, shopify_client_id', (q) =>
    scopeShopQuery(q, shopDomain),
  );
  const selection = resolveSingleShopSelection(candidates, shopDomain);
  if (!selection.ok) {
    throw new Error(`shop_selection:${selection.reason}`);
  }
  return selection.shop;
}

async function loadShopCredentials(shopId) {
  const shops = await fetchAll(
    'shop',
    'id, shop_domain, shopify_client_id, access_token_encrypted, refresh_token_encrypted, access_token_expires_at, refresh_token_expires_at',
    (q) => q.eq('id', shopId),
  );
  const selection = resolveSingleShopSelection(shops, shops[0]?.shop_domain);
  if (!selection.ok) {
    throw new Error(`shop_credentials:${selection.reason}`);
  }
  return selection.shop;
}

async function loadActiveConnections(shopDomain) {
  const selectedShop = await loadSelectedShop(shopDomain);
  const connections = await fetchAll(
    'store_connection',
    'id, merchant_account_id, shop_id, external_identifier, platform_app_id, status',
    (q) => scopeActiveConnectionQuery(q, selectedShop.id),
  );
  const connectionSelection = resolveSingleConnectionSelection(connections);
  if (!connectionSelection.ok) {
    throw new Error(`shop_selection:${connectionSelection.reason}`);
  }
  const shop = await loadShopCredentials(selectedShop.id);
  const shopById = new Map([[shop.id, shop]]);

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

  return { connections: [connectionSelection.connection], shopById, tokenByConnection };
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

export async function planConnection({ connection, shop, app, knownToken }) {
  const tokenResult = await getPlanAccessToken(shop);

  if (!tokenResult.ok) {
    return { connection, shop, app, blocked: true, reason: tokenResult.reason, topics: [] };
  }

  const subscriptions = await listSubscriptions(shop.shop_domain, tokenResult.accessToken);
  const byTopic = subscriptionsByGraphqlTopic(subscriptions);
  const ourOrigin = baseUrl.origin;
  const hasLocalToken = Boolean(knownToken && !knownToken.revoked_at);
  const knownPublicId = hasLocalToken ? knownToken.public_id : null;

  const topics = [];
  for (const topic of ADMIN_API_TOPICS) {
    const existingForTopic = byTopic.get(topic.graphql) ?? [];
    const result = planTopicAction({ existingForTopic, knownPublicId, ourOrigin });
    topics.push({ topic: topic.rest, graphqlTopic: topic.graphql, ...result });
  }

  for (const topic of APP_LEVEL_ONLY_TOPICS) {
    topics.push({
      topic,
      graphqlTopic: null,
      action: 'non_applicable',
      detail:
        "non souscriptible via l'Admin API (absent de l'enum WebhookSubscriptionTopic) — reste sur l'ancien endpoint, identité par corps signé.",
    });
  }

  const inventory = subscriptions.map((sub) => ({
    topic: sub.topic,
    subscriptionId: sub.id,
    endpointType: sub.endpoint?.__typename ?? 'inconnu',
    callbackUrl: maskIngestUrl(sub.endpoint?.callbackUrl),
  }));

  return {
    connection,
    shop,
    app,
    blocked: false,
    hasLocalToken,
    topics,
    inventory,
    tokenResult,
  };
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

    log(`  Jeton local : ${r.hasLocalToken ? 'existant' : 'absent'}`);
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

    const plan = decideConnectionApplyPlan({ topics: r.topics, hasLocalToken: r.hasLocalToken });
    if (plan.kind === 'requires_rotation') {
      log(
        `  --apply refusera de toucher cette connexion (jeton déjà existant + ${plan.actionable.length} topic(s) actionnable(s)) : --rotate-token ${r.connection.id} requis.`,
      );
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
  const needsRotation = results.filter(
    (r) =>
      !r.blocked &&
      decideConnectionApplyPlan({ topics: r.topics, hasLocalToken: r.hasLocalToken }).kind ===
        'requires_rotation',
  ).length;

  if (blockedCount > 0 || anomalies.length > 0 || needsRotation > 0) {
    log('');
    log(
      `ATTENTION : ${blockedCount} boutique(s) bloquée(s), ${anomalies.length} anomalie(s), ${needsRotation} boutique(s) nécessitant --rotate-token.`,
    );
  }
}

// ── --apply ──────────────────────────────────────────────────────────────────────────────
async function registerTopic({ shopDomain, accessToken, topic, existingId, input }) {
  if (existingId) {
    const data = await shopifyGraphQL({
      shopDomain,
      accessToken,
      query: WEBHOOK_SUBSCRIPTION_UPDATE,
      variables: { id: existingId, webhookSubscription: input },
    });
    const errors = data.webhookSubscriptionUpdate.userErrors;
    return errors.length === 0
      ? { ok: true, mutation: 'update' }
      : { ok: false, detail: maskSensitiveText(errors.map((e) => e.message).join('; ')) };
  }
  const data = await shopifyGraphQL({
    shopDomain,
    accessToken,
    query: WEBHOOK_SUBSCRIPTION_CREATE,
    variables: { topic, webhookSubscription: input },
  });
  const errors = data.webhookSubscriptionCreate.userErrors;
  return errors.length === 0
    ? { ok: true, mutation: 'create' }
    : { ok: false, detail: maskSensitiveText(errors.map((e) => e.message).join('; ')) };
}

// Vérifie, pour chacun des `topics` donnés, qu'il existe EXACTEMENT un abonnement pointant vers
// `publicId` — et retire tout abonnement périmé trouvé en plus (remplacer, jamais ajouter).
async function verifyAndCleanup({ shopDomain, accessToken, topics, publicId }) {
  const fresh = await listSubscriptions(shopDomain, accessToken);
  const freshByTopic = subscriptionsByGraphqlTopic(fresh);
  const verification = [];

  for (const t of topics) {
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
        shopDomain,
        accessToken,
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
            : `échec de retrait de l'abonnement périmé (${staleSub.id}) : ${maskSensitiveText(errors.map((e) => e.message).join('; '))}`,
      });
    }

    verification.push({
      topic: t.topic,
      ok: true,
      subscriptionId: matching[0].id,
      detail: 'relecture confirmée : un seul abonnement, jeton courant.',
    });
  }

  return verification;
}

async function applyConnection(planned) {
  if (planned.blocked) {
    return { shopDomain: planned.shop.shop_domain, ok: false, reason: `bloqué: ${planned.reason}` };
  }

  const decision = decideConnectionApplyPlan({
    topics: planned.topics,
    hasLocalToken: planned.hasLocalToken,
  });

  if (decision.kind === 'blocked_anomalie') {
    return {
      shopDomain: planned.shop.shop_domain,
      ok: false,
      reason: `${decision.blocking.length} anomalie(s) non résolue(s) automatiquement — ${decision.blocking.map((b) => `${b.topic}: ${b.detail}`).join(' | ')}`,
    };
  }

  if (decision.kind === 'already_conformant') {
    // Zéro appel réseau de mutation. Les 3 invariants d'idempotence (jeton, URL cible, id
    // d'abonnement) restent inchangés PAR CONSTRUCTION — aucune mutation n'est même tentée.
    // Rapporté explicitement, topic par topic, plutôt qu'un simple "rien à faire" global.
    return {
      shopDomain: planned.shop.shop_domain,
      ok: true,
      changed: false,
      alreadyConformant: planned.topics
        .filter((t) => t.action === 'conforme')
        .map((t) => ({ topic: t.topic, subscriptionId: t.existingId })),
    };
  }

  if (decision.kind === 'requires_rotation') {
    // JAMAIS de rotation implicite : cf. en-tête de fichier. Signalé, pas résolu automatiquement.
    return {
      shopDomain: planned.shop.shop_domain,
      ok: false,
      needsRotation: true,
      connectionId: planned.connection.id,
      reason: `${decision.actionable.length} topic(s) actionnable(s) mais un jeton existe déjà pour cette connexion — exécuter --rotate-token ${planned.connection.id} explicitement.`,
    };
  }

  // decision.kind === 'provision' : aucun jeton local n'existe encore pour cette connexion —
  // création sûre, rien à invalider côté Shopify (aucun topic n'était déjà 'conforme').
  const { publicId, secret } = await createWebhookToken(admin, planned.connection.id);
  const url = targetUrl(publicId, secret);
  const input = { callbackUrl: url, format: 'JSON' };

  const changes = [];
  for (const t of decision.actionable) {
    const result = await registerTopic({
      shopDomain: planned.shop.shop_domain,
      accessToken: planned.tokenResult.accessToken,
      topic: t.graphqlTopic,
      existingId: t.existingId ?? null,
      input,
    });
    changes.push({ topic: t.topic, ...result });
  }

  const verification = await verifyAndCleanup({
    shopDomain: planned.shop.shop_domain,
    accessToken: planned.tokenResult.accessToken,
    topics: decision.actionable,
    publicId,
  });

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
    if (r.needsRotation) {
      log(`  ROTATION REQUISE : ${r.reason}`);
      continue;
    }
    if (!r.ok && !r.changed) {
      log(`  ÉCHEC : ${r.reason}`);
      continue;
    }
    if (!r.changed) {
      log('  Déjà conforme — AUCUNE mutation tentée. Invariants inchangés :');
      for (const t of r.alreadyConformant) {
        log(`    ${t.topic.padEnd(28)} id=${t.subscriptionId} (inchangé)`);
      }
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
  const needsRotationCount = results.filter((r) => r.needsRotation).length;
  if (failed.length > 0) {
    logError(
      `webhook-subscription-migration: ${failed.length} boutique(s) non validée(s), dont ${needsRotationCount} nécessitant --rotate-token.`,
    );
  }
  return failed.length;
}

// ── --rotate-token ───────────────────────────────────────────────────────────────────────
// Fait tourner le secret PUIS re-enregistre les 9 topics Admin-API en une seule passe synchrone
// (jamais étalé sur plusieurs runs futurs — « les abonnements sont recréés avant l'expiration de
// l'ancien secret, jamais après »). L'ancien secret reste valide durant la fenêtre de grâce
// (24h, cf. scripts/lib/webhook-token-provisioning.mjs) : si cette passe échoue en cours de
// route, les topics déjà re-enregistrés restent valides et les topics non encore traités
// continuent de fonctionner sur l'ancien secret jusqu'à expiration de la fenêtre — la
// vérification finale par relecture couvre l'ensemble des 9 topics, pas seulement ceux qui
// semblaient actionnables avant la rotation.
async function rotateConnection(connectionId, shopDomain) {
  const selectedShop = await loadSelectedShop(shopDomain);
  const { data: connection, error: connectionError } = await admin
    .from('store_connection')
    .select('id, merchant_account_id, shop_id, status')
    .eq('id', connectionId)
    .eq('platform', 'shopify')
    .eq('shop_id', selectedShop.id)
    .maybeSingle();

  if (connectionError || !connection) {
    logError(`webhook-subscription-migration: store_connection introuvable (id=${connectionId}).`);
    process.exit(1);
  }
  if (connection.status !== 'active') {
    logError(
      `webhook-subscription-migration: store_connection ${connectionId} n'est pas active (status=${connection.status}) — rotation refusée.`,
    );
    process.exit(1);
  }

  const { data: shop, error: shopError } = await admin
    .from('shop')
    .select(
      'id, shop_domain, shopify_client_id, access_token_encrypted, refresh_token_encrypted, access_token_expires_at, refresh_token_expires_at',
    )
    .eq('id', connection.shop_id)
    .maybeSingle();

  if (shopError || !shop) {
    logError(`webhook-subscription-migration: shop introuvable pour connexion ${connectionId}.`);
    process.exit(1);
  }

  const app = shop.shopify_client_id ? (appsByClientId.get(shop.shopify_client_id) ?? null) : null;
  if (!app) {
    logError(
      `webhook-subscription-migration: app Shopify inconnue pour ${shop.shop_domain} (client_id=${shop.shopify_client_id ?? 'null'}).`,
    );
    process.exit(1);
  }

  const tokenResult = await getValidAccessToken(admin, shop, app);
  if (!tokenResult.ok) {
    logError(
      `webhook-subscription-migration: jeton Admin API indisponible pour ${shop.shop_domain} (${tokenResult.reason}).`,
    );
    process.exit(1);
  }

  const existingBefore = await getWebhookToken(admin, connectionId);
  log(
    `webhook-subscription-migration --rotate-token: ${shop.shop_domain} — jeton ${existingBefore ? 'existant, rotation' : 'absent, création'}.`,
  );

  const { publicId, secret } = await rotateWebhookToken(admin, connectionId);
  const url = targetUrl(publicId, secret);
  const input = { callbackUrl: url, format: 'JSON' };

  const subscriptions = await listSubscriptions(shop.shop_domain, tokenResult.accessToken);
  const byTopic = subscriptionsByGraphqlTopic(subscriptions);

  const changes = [];
  for (const topic of ADMIN_API_TOPICS) {
    const existing = byTopic.get(topic.graphql) ?? [];
    // En rotation, TOUS les topics sont re-enregistrés — y compris ceux déjà 'conforme' avant la
    // rotation, puisque la rotation invalide leur URL. `existing[0]?.id` réutilise
    // l'identifiant Shopify existant s'il y en a un (update, jamais un doublon) ; s'il y en avait
    // plus d'un (anomalie préexistante), on cible le premier et on nettoie les autres à la
    // vérification finale, comme --apply.
    const result = await registerTopic({
      shopDomain: shop.shop_domain,
      accessToken: tokenResult.accessToken,
      topic: topic.graphql,
      existingId: existing[0]?.id ?? null,
      input,
    });
    changes.push({ topic: topic.rest, graphqlTopic: topic.graphql, ...result });
  }

  const verification = await verifyAndCleanup({
    shopDomain: shop.shop_domain,
    accessToken: tokenResult.accessToken,
    topics: changes,
    publicId,
  });

  log('=== webhook-subscription-migration --rotate-token ===');
  log(`— ${shop.shop_domain} (connexion=${connectionId})`);
  for (const c of changes) {
    log(`  mutation ${c.mutation ?? '?'} topic=${c.topic} ${c.ok ? 'OK' : `ÉCHEC: ${c.detail}`}`);
  }
  for (const v of verification) {
    log(`  relecture topic=${v.topic} ${v.ok ? 'OK' : `ÉCHEC: ${v.detail}`}`);
  }

  const allOk = changes.every((c) => c.ok) && verification.every((v) => v.ok);
  if (!allOk) {
    logError(
      "webhook-subscription-migration --rotate-token: ÉCHEC PARTIEL — les topics en échec restent sur l'ANCIEN secret (fenêtre de grâce 24h) ; ré-exécuter --rotate-token sur la même connexion avant expiration.",
    );
  } else {
    log('webhook-subscription-migration --rotate-token: rotation confirmée sur les 9 topics.');
  }
  process.exit(allOk ? 0 : 1);
}

// ── main ─────────────────────────────────────────────────────────────────────────────────
async function main() {
  if (mode === 'rotate') {
    await rotateConnection(rotateConnectionId, selectedShopDomain);
    return;
  }

  const { connections, shopById, tokenByConnection } =
    await loadActiveConnections(selectedShopDomain);

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

if (process.env.NODE_ENV !== 'test') {
  main().catch((error) => {
    logError(`webhook-subscription-migration: échec contrôlé (${controlledErrorMessage(error)}).`);
    process.exit(1);
  });
}
