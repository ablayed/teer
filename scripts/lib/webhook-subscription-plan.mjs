// Logique de décision PURE (aucun import Supabase, aucun appel réseau) du diagnostic des
// abonnements webhook Shopify (scripts/webhook-subscription-migration.mjs --plan). Extraite du
// script pour être testable — voir tests/unit/shopify/webhook-subscription-plan.test.ts.
//
// SHOPIFY-WEBHOOKS-PER-SHOP-1B / G10 — ce module ne porte plus aucune décision de MUTATION :
// `--apply` et `--rotate-token` sont retirés, et avec eux l'orchestration du rafraîchissement
// d'un jeton (qui n'existe plus que dans lib/shopify/oauth.ts et lib/shopify/token.ts). Les
// abonnements sont créés, réparés et tournés par l'application
// (lib/shopify/webhook-subscription-reconcile.ts).

import { INGEST_PATH_PREFIX } from '../../lib/shopify/webhook-subscription-inventory.ts';

// Les topics créés PAR BOUTIQUE vivent dans lib/shopify/webhook-subscription-topics.ts, source
// unique partagée avec la réconciliation applicative. ADMIN_API_TOPICS : les huit topics métier.
// PER_SHOP_SUBSCRIPTION_TOPICS : ces huit, plus `app/uninstalled` (lot 1b, E0).
export {
  ADMIN_API_TOPICS,
  PER_SHOP_SUBSCRIPTION_TOPICS,
} from '../../lib/shopify/webhook-subscription-topics.ts';

export { INGEST_PATH_PREFIX };

// Non souscriptibles par l'Admin API (absents de l'enum WebhookSubscriptionTopic, vérifié
// contre la documentation Shopify avant d'écrire ce script — jamais supposé). Restent
// configurés au niveau app et continuent de router vers l'ancien endpoint signé par corps.
export const APP_LEVEL_ONLY_TOPICS = ['customers/data_request', 'customers/redact', 'shop/redact'];

// `app/uninstalled` est, LUI, parfaitement souscriptible par l'Admin API — il figure bien dans
// l'enum WebhookSubscriptionTopic. Il reste déclaré au niveau app par DÉCISION, pas par
// incapacité : les deux raisons sont différentes et ne doivent jamais être fusionnées.
//
// Fait Shopify, établi depuis la documentation (query `webhookSubscriptions`, Admin GraphQL) :
// « Returns only shop-scoped subscriptions, not app-scoped subscriptions configured in TOML
// files ». Un abonnement déclaré dans `shopify.app.*.toml` est donc STRUCTURELLEMENT invisible à
// l'inventaire, et ne se supprime pas par l'Admin API.
//
// Depuis le lot 1b (E0), `app/uninstalled` est AUSSI souscrit par boutique sur l'URL opaque
// (PER_SHOP_SUBSCRIPTION_TOPICS), pour que la désinstallation soit résolue par le jeton d'URL.
// Tant que la déclaration du TOML n'est pas retirée (E11, hors de ce lot), chaque désinstallation
// produit donc DEUX livraisons, sur les deux endpoints. C'est assumé : la primitive ordonnée
// (`uninstall_shopify_pending_or_shop_ordered`, 0161) rend la seconde sans effet.
export const APP_LEVEL_BY_DECISION_TOPICS = ['app/uninstalled'];

// Les 4 topics déclarés dans le TOML de l'app, tous servis par l'endpoint legacy signé par corps.
export const APP_LEVEL_TOPICS = [...APP_LEVEL_ONLY_TOPICS, ...APP_LEVEL_BY_DECISION_TOPICS];

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

// Jeton d'accès pour le diagnostic : DÉCHIFFRÉ, jamais renouvelé. Un jeton expirant proche de son
// échéance rend `renewal_required` : le script ne rafraîchit rien. Pour obtenir un jeton frais,
// lancer une synchronisation depuis Tëër (Paramètres > Boutiques), puis relancer le diagnostic.
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

export function scopeShopQuery(query, shopDomain) {
  return query.eq('shop_domain', shopDomain);
}

export function scopeActiveConnectionQuery(query, shopId) {
  return query.eq('platform', 'shopify').eq('status', 'active').eq('shop_id', shopId);
}

const PLAN_FAILURE_CODES = new Set([
  'db_read_failure',
  'token_decryption_failure',
  'shopify_read_failure',
  'unknown_failure',
]);

export async function withPlanFailure(code, operation) {
  try {
    return await operation();
  } catch {
    const tagged = new Error('plan stage failed');
    tagged.code = PLAN_FAILURE_CODES.has(code) ? code : 'unknown_failure';
    throw tagged;
  }
}

export function controlledErrorMessage(error) {
  let code;
  try {
    code = error && typeof error === 'object' ? error.code : undefined;
  } catch {
    code = undefined;
  }
  return `cause=${PLAN_FAILURE_CODES.has(code) ? code : 'unknown_failure'}`;
}

// Masquage d'un texte libre : tout segment de jeton opaque y est remplacé, systématiquement.
export function maskSensitiveText(value) {
  return typeof value === 'string'
    ? value.replace(OPAQUE_INGEST_SEGMENT, `${INGEST_PATH_PREFIX}***`)
    : value;
}

// Diagnostic par topic attendu, à partir de l'inventaire CLASSÉ
// (lib/shopify/webhook-subscription-inventory.ts `classifySubscriptions`). PURE : ne décide
// d'aucune mutation, elle dit ce que la réconciliation applicative ferait.
//
//   conforme   au moins un abonnement COURANT sur ce topic (`doublons` s'il y en a plusieurs) ;
//   precedent  aucun courant, au moins un abonnement sur l'empreinte PRÉCÉDENTE ;
//   absent     aucun abonnement reconnu sur ce topic.
export function summarizeTopicStates(classified, expectedTopics) {
  return expectedTopics.map((topic) => {
    const forTopic = classified.filter((subscription) => subscription.topic === topic.graphql);
    const current = forTopic.filter((s) => s.classification.kind === 'current').length;
    const previous = forTopic.filter((s) => s.classification.kind === 'previous').length;
    const foreign = forTopic.filter((s) => s.classification.kind === 'foreign').length;
    const state = current > 0 ? 'conforme' : previous > 0 ? 'precedent' : 'absent';
    return {
      topic: topic.rest,
      graphqlTopic: topic.graphql,
      state,
      current,
      previous,
      foreign,
      doublons: Math.max(current - 1, 0),
    };
  });
}

// Ce que la prochaine réconciliation ferait de cette boutique, sans le faire.
//   aucune_action          les neuf topics sont conformes ;
//   creation_sans_rotation au moins un abonnement courant existe : les topics manquants seront
//                          recréés avec son `uri`, sans rotation ;
//   rotation               aucun abonnement courant : le jeton sera créé ou tourné, puis les neuf
//                          topics créés.
export function summarizeReconcileOutlook(topicStates) {
  const anyCurrent = topicStates.some((topic) => topic.current > 0);
  if (!anyCurrent) {
    return 'rotation';
  }
  return topicStates.every((topic) => topic.state === 'conforme')
    ? 'aucune_action'
    : 'creation_sans_rotation';
}
