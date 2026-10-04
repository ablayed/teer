#!/usr/bin/env node
// ============================================================================
// Diagnostic, EN LECTURE SEULE, des abonnements webhook Shopify d'une boutique.
// ============================================================================
//
// Un seul mode : `--plan`. Il interroge l'Admin API de la boutique sélectionnée, classe chaque
// abonnement (courant, précédent, non reconnu) et dit ce que la prochaine réconciliation
// applicative ferait. AUCUNE mutation, ni chez Shopify ni en base : pas de jeton généré, pas de
// jeton rafraîchi, pas de bail pris.
//
// SHOPIFY-WEBHOOKS-PER-SHOP-1B / G10 — `--apply` et `--rotate-token` sont RETIRÉS. Les
// abonnements par boutique sont créés, réparés et tournés par l'application, sous bail
// (lib/shopify/webhook-subscription-reconcile.ts) : à la finalisation d'une connexion, à la
// relance manuelle (Paramètres > Boutiques), et par le cron `shopify-reconcile`. Un outil qui
// muterait ces abonnements hors de ce bail le contournerait.
//
// Usage :
//   node scripts/webhook-subscription-migration.mjs --plan --shop-domain boutique.myshopify.com
//   node scripts/webhook-subscription-migration.mjs --help
//
// Env requis par `--plan` :
//   WEBHOOK_MIGRATION_SUPABASE_URL, WEBHOOK_MIGRATION_SUPABASE_SERVICE_ROLE_KEY,
//   WEBHOOK_MIGRATION_SUPABASE_ALLOWED_ORIGIN — configuration de maintenance dédiée ;
//   SHOPIFY_TOKEN_ENCRYPTION_KEY (+ _PREVIOUS optionnel, cf. lib/shopify/crypto.ts) ;
//   au moins une paire SHOPIFY_*_API_KEY/SECRET (mêmes apps que lib/shopify/apps.ts) ;
//   WEBHOOK_PUBLIC_BASE_URL — HTTPS, sans slash final. Aucune URL en dur dans ce fichier.
//
// Jeton d'accès Admin : DÉCHIFFRÉ, jamais renouvelé. Un jeton expirant proche de son échéance
// bloque le diagnostic (`renewal_required`) : lancer une synchronisation depuis Tëër
// (Paramètres > Boutiques), qui le rafraîchit sous bail, puis relancer `--plan` dans l'heure.
//
// Discipline de secret : le jeton d'accès Admin ne sort jamais de la mémoire du processus. Une
// `uri` d'ingestion porte le secret du jeton L3 dans son chemin : toute `uri` affichée est
// MASQUÉE (lib/shopify/webhook-subscription-inventory.ts `maskSubscriptionUri`).
//
// Chargement sous le Node natif : ce fichier et tout ce qu'il importe n'utilisent AUCUN alias
// `@/` en valeur — Node ne lit pas tsconfig.json. Cette régression, introduite par un lot
// précédent et invisible sous vitest (qui résout l'alias), est verrouillée par un test qui lance
// réellement `node … --help` (tests/unit/shopify/webhook-subscription-script-node-load.test.ts).
import { verifyWebhookTokenSecret } from '../lib/ingestion/webhook-token.ts';
import { SHOPIFY_APP_ENV_KEYS } from '../lib/shopify/app-registry-sources.ts';
import { decryptToken } from '../lib/shopify/crypto.ts';
import { shopifyGraphQL } from '../lib/shopify/graphql.ts';
import {
  classifySubscriptions,
  listWebhookSubscriptions,
  maskSubscriptionUri,
  parseWebhookPublicBaseUrl,
} from '../lib/shopify/webhook-subscription-inventory.ts';
import { createMaintenanceSupabaseClient } from './lib/maintenance-supabase-client.mjs';
import {
  APP_LEVEL_TOPICS,
  PER_SHOP_SUBSCRIPTION_TOPICS,
  controlledErrorMessage,
  resolvePlanAccessToken,
  resolveSingleConnectionSelection,
  resolveSingleShopSelection,
  scopeActiveConnectionQuery,
  scopeShopQuery,
  summarizeReconcileOutlook,
  summarizeTopicStates,
  validateShopDomainSelection,
  withPlanFailure,
} from './lib/webhook-subscription-plan.mjs';

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

const USAGE = [
  'webhook-subscription-migration — diagnostic en lecture seule des abonnements webhook Shopify.',
  '',
  'Usage :',
  '  node scripts/webhook-subscription-migration.mjs --plan --shop-domain <boutique.myshopify.com>',
  '  node scripts/webhook-subscription-migration.mjs --help',
  '',
  '--apply et --rotate-token sont retirés : les abonnements sont créés et réparés par',
  "l'application (finalisation, relance manuelle, cron), sous bail.",
].join('\n');

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

if (argv.includes('--help') || argv.includes('-h')) {
  log(USAGE);
  process.exit(0);
}

if (argv.includes('--apply') || argv.includes('--rotate-token')) {
  logError(
    "webhook-subscription-migration: --apply et --rotate-token sont retirés (lot 1b, G10). Les abonnements sont réconciliés par l'application ; ce script ne fait plus que --plan.",
  );
  process.exit(1);
}

if (!argv.includes('--plan')) {
  logError(USAGE);
  process.exit(1);
}

const shopDomainFlagIndex = argv.indexOf('--shop-domain');
const rawShopDomain = shopDomainFlagIndex === -1 ? null : argv[shopDomainFlagIndex + 1];
const shopDomainSelection = validateShopDomainSelection(rawShopDomain);
if (!shopDomainSelection.ok) {
  logError(`webhook-subscription-migration: ${shopDomainSelection.reason}.`);
  process.exit(1);
}
const selectedShopDomain = shopDomainSelection.shopDomain;

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

// ── Env : origine publique des webhooks ──────────────────────────────────────────────────
// Jamais une URL en dur. Refus explicite, jamais un repli silencieux sur une valeur devinée.
const baseOrigin = parseWebhookPublicBaseUrl(process.env.WEBHOOK_PUBLIC_BASE_URL);
if (!baseOrigin) {
  logError(
    'webhook-subscription-migration: WEBHOOK_PUBLIC_BASE_URL requise (HTTPS, sans slash final ni chemin) — refus de démarrer.',
  );
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
// Simple table de correspondance client_id -> libellé, depuis la liste nommée une seule fois
// dans lib/shopify/app-registry-sources.ts (pur, zéro import). Le secret d'app n'est pas lu :
// un diagnostic en lecture seule n'en a aucun usage.
const appsByClientId = new Map();
for (const { label, clientIdKey } of SHOPIFY_APP_ENV_KEYS) {
  const clientId = process.env[clientIdKey];
  if (clientId) {
    appsByClientId.set(clientId, { label, clientId });
  }
}
if (appsByClientId.size === 0) {
  logError(
    'webhook-subscription-migration: aucune app Shopify configurée (SHOPIFY_*_API_KEY manquants) — refus de démarrer.',
  );
  process.exit(1);
}

// ── Chargement de la connexion active, de la boutique et du jeton L3 ──────────────────
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
  const candidates = await fetchAll(
    'shop',
    'id, shop_domain, shopify_client_id, access_token_encrypted, access_token_expires_at',
    (q) => scopeShopQuery(q, shopDomain),
  );
  const selection = resolveSingleShopSelection(candidates, shopDomain);
  if (!selection.ok) {
    throw new Error(`shop_selection:${selection.reason}`);
  }
  return selection.shop;
}

async function loadActiveConnections(shopDomain) {
  const shop = await loadSelectedShop(shopDomain);
  const connections = await fetchAll(
    'store_connection',
    'id, shop_id, external_identifier, platform_app_id, status',
    (q) => scopeActiveConnectionQuery(q, shop.id),
  );
  const connectionSelection = resolveSingleConnectionSelection(connections);
  if (!connectionSelection.ok) {
    throw new Error(`shop_selection:${connectionSelection.reason}`);
  }
  const connection = connectionSelection.connection;

  // Empreintes seulement : le secret du jeton L3 n'est stocké nulle part.
  const tokens = await fetchAll(
    'store_connection_webhook_token',
    'public_id, secret_hash, previous_secret_hash, previous_secret_expires_at, revoked_at',
    (q) => q.eq('store_connection_id', connection.id),
  );
  const states = await fetchAll(
    'shopify_webhook_subscription_state',
    'topic, status, api_version, last_observed_at, last_error_code',
    (q) => q.eq('store_connection_id', connection.id),
  );

  return { connection, shop, knownToken: tokens[0] ?? null, states };
}

export async function loadPlanActiveConnections(shopDomain) {
  return withPlanFailure('db_read_failure', () => loadActiveConnections(shopDomain));
}

function getPlanAccessToken(shop) {
  return withPlanFailure('token_decryption_failure', () =>
    resolvePlanAccessToken({
      encryptedToken: shop.access_token_encrypted,
      expiresAt: shop.access_token_expires_at,
      decrypt: decryptToken,
      refreshBufferMs: REFRESH_BUFFER_MS,
    }),
  );
}

// Inventaire PAGINÉ (lib/shopify/webhook-subscription-inventory.ts).
async function listPlanSubscriptions(shopDomain, accessToken) {
  return withPlanFailure('shopify_read_failure', () =>
    listWebhookSubscriptions((query, variables) =>
      shopifyGraphQL({ shopDomain, accessToken, query, variables }),
    ),
  );
}

export async function planConnection({ connection, shop, app, knownToken }) {
  const tokenResult = await getPlanAccessToken(shop);

  if (!tokenResult.ok) {
    return { connection, shop, app, blocked: true, reason: tokenResult.reason, topics: [] };
  }

  const subscriptions = await listPlanSubscriptions(shop.shop_domain, tokenResult.accessToken);

  // Un jeton révoqué ne reconnaît plus rien : son secret ne doit pas être réutilisé.
  const usable = Boolean(knownToken && !knownToken.revoked_at);
  const classified = classifySubscriptions(subscriptions, {
    baseOrigin,
    publicId: knownToken?.public_id ?? null,
    currentSecretHash: usable ? knownToken.secret_hash : null,
    previousSecretHash: usable ? knownToken.previous_secret_hash : null,
    verifySecret: verifyWebhookTokenSecret,
  });

  const topics = summarizeTopicStates(classified, PER_SHOP_SUBSCRIPTION_TOPICS);

  // Sortie de diagnostic : `uri` MASQUÉE, jamais la valeur renvoyée par Shopify.
  const inventory = classified.map((subscription) => ({
    topic: subscription.topic,
    subscriptionId: subscription.id,
    apiVersion: subscription.apiVersion ?? 'inconnue',
    classification:
      subscription.classification.kind === 'foreign'
        ? `non reconnu${subscription.classification.onOurOrigin ? ' (notre origine)' : ''}`
        : subscription.classification.kind === 'current'
          ? 'courant'
          : 'précédent',
    uri: maskSubscriptionUri(subscription.uri),
  }));

  return {
    connection,
    shop,
    app,
    blocked: false,
    localToken: knownToken ? (knownToken.revoked_at ? 'révoqué' : 'présent') : 'absent',
    topics,
    inventory,
    outlook: summarizeReconcileOutlook(topics),
  };
}

function printPlanReport(result, states) {
  log('=== webhook-subscription-migration --plan (lecture seule) ===');
  log(`— ${result.shop.shop_domain} (app=${result.app.label}, connexion=${result.connection.id})`);

  if (result.blocked) {
    log(`  BLOQUÉ : jeton Admin API indisponible (${result.reason}).`);
    if (result.reason === 'renewal_required') {
      log(
        '  Ce script ne rafraîchit aucun jeton : lancer une synchronisation depuis Tëër (Paramètres > Boutiques), puis relancer --plan.',
      );
    }
    return;
  }

  log(`  Jeton d'URL local : ${result.localToken}`);
  log(`  Inventaire Shopify (${result.inventory.length} abonnement(s), tous topics) :`);
  for (const entry of result.inventory) {
    log(
      `    ${entry.topic.padEnd(26)} ${entry.classification.padEnd(28)} api=${entry.apiVersion} id=${entry.subscriptionId} ${entry.uri}`,
    );
  }

  log(`  Topics attendus par boutique (${result.topics.length}) :`);
  for (const topic of result.topics) {
    const detail = `courant=${topic.current} précédent=${topic.previous} non reconnu=${topic.foreign}`;
    log(
      `    ${topic.topic.padEnd(26)} ${topic.state.padEnd(10)} ${detail}${topic.doublons > 0 ? ` — ${topic.doublons} doublon(s)` : ''}`,
    );
  }

  log(`  Niveau app (TOML, invisibles à cet inventaire) : ${APP_LEVEL_TOPICS.join(', ')}`);

  log(`  État consigné localement (${states.length} ligne(s)) :`);
  for (const state of states) {
    log(
      `    ${state.topic.padEnd(26)} ${state.status.padEnd(8)} api=${state.api_version ?? '-'} observé=${state.last_observed_at ?? '-'}${state.last_error_code ? ` erreur=${state.last_error_code}` : ''}`,
    );
  }

  log(`  Prochaine réconciliation : ${result.outlook}`);
}

// ── main ─────────────────────────────────────────────────────────────────────────────────
async function main() {
  const { connection, shop, knownToken, states } =
    await loadPlanActiveConnections(selectedShopDomain);

  const app = shop.shopify_client_id ? (appsByClientId.get(shop.shopify_client_id) ?? null) : null;
  if (!app) {
    log('=== webhook-subscription-migration --plan (lecture seule) ===');
    log(`— ${shop.shop_domain} : BLOQUÉ, app Shopify inconnue de cet environnement.`);
    process.exit(1);
  }

  const result = await planConnection({ connection, shop, app, knownToken });
  printPlanReport(result, states);
  process.exit(result.blocked ? 1 : 0);
}

export function reportControlledFailure(error) {
  logError(`webhook-subscription-migration: échec contrôlé (${controlledErrorMessage(error)}).`);
}

if (process.env.NODE_ENV !== 'test') {
  main().catch((error) => {
    reportControlledFailure(error);
    process.exit(1);
  });
}
