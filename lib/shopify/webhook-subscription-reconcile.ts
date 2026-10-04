// SHOPIFY-WEBHOOKS-PER-SHOP-1B / C3 — réconciliation des abonnements webhook d'une boutique
// (G2, G3, G12).
//
// Fait converger les abonnements enregistrés chez Shopify vers les neuf topics attendus
// (lib/shopify/webhook-subscription-topics.ts), tous sur l'URL opaque de la connexion.
//
//   1. inventaire PAGINÉ, et reconnaissance de chaque abonnement (webhook-subscription-inventory) ;
//   2. au moins un abonnement COURANT : chaque topic manquant est recréé avec l'`uri` de cet
//      abonnement, SANS rotation ;
//   3. aucun abonnement courant : rotation LOCALE D'ABORD — l'empreinte est écrite avant tout
//      appel à Shopify —, puis création des topics, puis état ;
//   4. les abonnements sur l'empreinte PRÉCÉDENTE ne sont supprimés qu'après la création des
//      nouveaux ; un abonnement courant n'est jamais supprimé (E10) ; un abonnement non reconnu
//      est signalé, jamais supprimé ;
//   5. l'état de chaque topic est consigné dans `shopify_webhook_subscription_state`.
//
// BAIL. Tout s'exécute sous le bail de réconciliation de la connexion (0161), indépendant du bail
// des jetons : `getValidShopAccessToken` prend et rend le sien, rien n'est imbriqué.
//
// FENCING DES ÉCRITURES — et pas seulement de la libération. 0161 ne fournit aucune primitive SQL
// qui vérifie la génération sur l'état : les écritures sont donc conditionnées atomiquement,
// chacune par un filtre évalué dans l'instruction même.
//   - état : écriture MONOTONE sur `last_observed_at`. La valeur écrite est l'`acquired_at` du
//     bail du détenteur, lu à l'horloge de la base : il croît strictement d'une génération à la
//     suivante. Un détenteur périmé porte une valeur plus ancienne que celle déjà écrite par son
//     successeur : son UPDATE ne trouve aucune ligne ;
//   - jeton L3 : compare-and-set sur l'empreinte lue (lib/ingestion/webhook-token-provisioning) ;
//   - appels à Shopify qui créent ou suppriment : la génération et l'échéance du bail sont
//     REVÉRIFIÉES immédiatement avant chaque appel ; une suppression relit en plus le jeton, et ne
//     vise jamais un abonnement redevenu courant.
//
// Module pur de toute dépendance d'environnement : l'origine publique est reçue en entrée.
import { verifyWebhookTokenSecret } from '@/lib/ingestion/webhook-token';
import {
  type WebhookTokenRotationMode,
  type WebhookTokenRow,
  createWebhookToken,
  readWebhookToken,
  resolveRotationMode,
  rotateWebhookToken,
} from '@/lib/ingestion/webhook-token-provisioning';
import {
  SHOPIFY_API_VERSION,
  isShopifyUnauthorizedError,
  shopifyGraphQL,
} from '@/lib/shopify/graphql';
import { getValidShopAccessToken, runWithShopifyUnauthorizedRetry } from '@/lib/shopify/token';
import {
  type ClassifiedSubscription,
  type WebhookGraphQLExecutor,
  buildIngestUri,
  classifySubscriptionUri,
  classifySubscriptions,
  listWebhookSubscriptions,
  parseWebhookPublicBaseUrl,
} from '@/lib/shopify/webhook-subscription-inventory';
import {
  PER_SHOP_SUBSCRIPTION_TOPICS,
  type ShopifyWebhookTopic,
} from '@/lib/shopify/webhook-subscription-topics';
import type { Database } from '@/lib/supabase/database.types';
import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

type AdminClient = SupabaseClient<Database>;

// TTL du bail de réconciliation. L'opération la plus longue est une installation : un inventaire,
// neuf créations, quelques lectures et écritures locales — chaque appel Shopify est borné à
// SHOPIFY_WEBHOOK_REQUEST_TIMEOUT_MS. Un dépassement n'est jamais une corruption : les écritures
// sont fencées, et le détenteur s'arrête de lui-même avant l'échéance (marge ci-dessous).
export const SHOPIFY_WEBHOOK_RECONCILE_LEASE_TTL_SECONDS = 60;
// Le détenteur cesse d'appeler Shopify cette durée AVANT l'échéance de son bail, mesurée à son
// horloge monotone depuis l'instant qui précède l'acquisition : la borne est donc conservatrice
// quel que soit l'écart entre son horloge et celle de la base.
const LEASE_SAFETY_MARGIN_MS = 5_000;
export const SHOPIFY_WEBHOOK_REQUEST_TIMEOUT_MS = 10_000;

export type WebhookReconcileFailureReason =
  | 'base_url_unavailable'
  | 'shop_unavailable'
  | 'connection_unavailable'
  | 'lease_held'
  | 'lease_error'
  | 'lease_lost'
  | 'access_token_unavailable'
  | 'token_read_failed'
  | 'token_conflict'
  | 'token_write_failed'
  | 'inventory_failed'
  | 'subscription_create_failed'
  | 'state_write_failed'
  | 'exception';

export type WebhookReconcileResult =
  | {
      ok: true;
      // Vrai si le secret du jeton L3 a été créé ou tourné pendant cette exécution.
      rotated: boolean;
      // Mode effectivement appliqué à la rotation ; NULL sans rotation.
      rotationMode: WebhookTokenRotationMode | null;
      created: number;
      deletedPrevious: number;
      foreign: number;
      duplicates: number;
    }
  | { ok: false; reason: WebhookReconcileFailureReason };

export type WebhookReconcileInput = {
  shopId: string;
  app: { clientId: string; clientSecret: string };
  // DÉCLARÉ par l'appelant : la finalisation déclare `installation`, la relance manuelle et le
  // cron déclarent `repair`.
  mode: WebhookTokenRotationMode;
  // Valeur brute de WEBHOOK_PUBLIC_BASE_URL, lue par l'appelant.
  webhookBaseUrl: string | null | undefined;
};

export type WebhookReconcileDeps = {
  graphql: typeof shopifyGraphQL;
  getAccessToken: typeof getValidShopAccessToken;
  // Horloge monotone, en millisecondes. Injectable pour les tests.
  monotonicNow: () => number;
};

const defaultDeps: WebhookReconcileDeps = {
  graphql: shopifyGraphQL,
  getAccessToken: getValidShopAccessToken,
  monotonicNow: () => performance.now(),
};

// Sentinelle expurgée : ni domaine, ni locataire, ni `uri`, ni jeton — seul le verdict technique.
function reportReconcileFailure(
  reason: WebhookReconcileFailureReason,
  mode: WebhookTokenRotationMode,
): void {
  // Un bail tenu est une collision attendue (finalisation, relance et cron peuvent se croiser).
  const level = reason === 'lease_held' ? 'info' : 'warning';
  Sentry.captureMessage('shopify_webhook_reconcile_failed', {
    level,
    tags: { module: 'shopify.webhook-reconcile', reason, mode },
  });
}

function reportReconcileObservation(
  observation: 'foreign_subscription' | 'duplicate_subscription' | 'api_version_drift',
): void {
  Sentry.captureMessage('shopify_webhook_reconcile_observation', {
    level: 'warning',
    tags: { module: 'shopify.webhook-reconcile', observation },
  });
}

type ReconcileLease = {
  readonly connectionId: string;
  readonly generation: number;
  // `acquired_at` du bail, tel que la base le rend (précision de la base) : jeton de fencing des
  // écritures d'état.
  readonly acquiredAt: string;
  // Instant, à l'horloge monotone locale, après lequel plus aucun appel Shopify n'est lancé.
  readonly localDeadline: number;
};

async function acquireReconcileLease(
  admin: AdminClient,
  connectionId: string,
  deps: WebhookReconcileDeps,
): Promise<
  { ok: true; lease: ReconcileLease } | { ok: false; reason: 'lease_held' | 'lease_error' }
> {
  // Pris AVANT l'appel : l'échéance réelle (horloge de la base) est postérieure à cette borne.
  const startedAt = deps.monotonicNow();
  const { data, error } = await admin.rpc('acquire_shopify_webhook_reconcile_lease', {
    p_store_connection_id: connectionId,
    p_ttl_seconds: SHOPIFY_WEBHOOK_RECONCILE_LEASE_TTL_SECONDS,
  });
  if (error) {
    return { ok: false, reason: 'lease_error' };
  }
  const row = data?.[0];
  if (!row) {
    return { ok: false, reason: 'lease_held' };
  }

  const { data: leaseRow, error: leaseError } = await admin
    .from('shopify_webhook_reconcile_lease')
    .select('generation, acquired_at')
    .eq('store_connection_id', connectionId)
    .maybeSingle();
  if (
    leaseError ||
    !leaseRow ||
    leaseRow.generation !== row.acquired_generation ||
    !leaseRow.acquired_at
  ) {
    // Bail déjà repris entre l'acquisition et la relecture : rien n'a été fait.
    return { ok: false, reason: 'lease_error' };
  }

  return {
    ok: true,
    lease: {
      connectionId,
      generation: row.acquired_generation,
      acquiredAt: leaseRow.acquired_at,
      localDeadline:
        startedAt + SHOPIFY_WEBHOOK_RECONCILE_LEASE_TTL_SECONDS * 1000 - LEASE_SAFETY_MARGIN_MS,
    },
  };
}

// Revérification du bail : génération ET échéance. Appelée immédiatement avant chaque appel
// Shopify qui crée ou supprime, et avant la rotation du jeton.
async function leaseStillHeld(
  admin: AdminClient,
  lease: ReconcileLease,
  deps: WebhookReconcileDeps,
): Promise<boolean> {
  if (deps.monotonicNow() >= lease.localDeadline) {
    return false;
  }
  const { data, error } = await admin
    .from('shopify_webhook_reconcile_lease')
    .select('generation, lease_expires_at')
    .eq('store_connection_id', lease.connectionId)
    .maybeSingle();
  return (
    !error &&
    Boolean(data) &&
    data?.generation === lease.generation &&
    data.lease_expires_at !== null
  );
}

// Libération FENCÉE par la génération du détenteur (0161). Zéro ligne (bail repris) n'est pas une
// erreur ; un échec laisse le bail expirer à son TTL.
async function releaseReconcileLease(admin: AdminClient, lease: ReconcileLease): Promise<void> {
  const { error } = await admin.rpc('release_shopify_webhook_reconcile_lease', {
    p_store_connection_id: lease.connectionId,
    p_generation: lease.generation,
  });
  if (error) {
    Sentry.captureException(new Error('shopify_webhook_reconcile_lease_release_failed'), {
      tags: { module: 'shopify.webhook-reconcile' },
      extra: { code: error.code },
    });
  }
}

type StateFields = {
  tokenPublicId: string;
  status: 'pending' | 'active' | 'failed';
  subscriptionId: string | null;
  apiVersion: string | null;
  errorCode: string | null;
};

type StateWriteOutcome = 'written' | 'fenced' | 'error';

// Écriture d'état conditionnelle MONOTONE. La ligne n'est écrite que si sa dernière observation
// est NULL ou antérieure (ou égale : le même détenteur écrit plusieurs fois) à l'`acquired_at` du
// bail de l'écrivain. La condition est dans l'instruction : aucune fenêtre entre contrôle et
// écriture.
async function writeSubscriptionState(
  admin: AdminClient,
  lease: ReconcileLease,
  topic: string,
  fields: StateFields,
): Promise<StateWriteOutcome> {
  const values = {
    shopify_subscription_id: fields.subscriptionId,
    token_public_id: fields.tokenPublicId,
    status: fields.status,
    api_version: fields.apiVersion,
    last_observed_at: lease.acquiredAt,
    last_error_code: fields.errorCode,
  };

  const conditionalUpdate = () =>
    admin
      .from('shopify_webhook_subscription_state')
      .update(values)
      .eq('store_connection_id', lease.connectionId)
      .eq('topic', topic)
      .or(`last_observed_at.is.null,last_observed_at.lte."${lease.acquiredAt}"`)
      .select('id');

  const updated = await conditionalUpdate();
  if (updated.error) {
    return 'error';
  }
  if ((updated.data ?? []).length > 0) {
    return 'written';
  }

  // Aucune ligne écrite : soit la ligne n'existe pas, soit un successeur l'a déjà écrite.
  const inserted = await admin
    .from('shopify_webhook_subscription_state')
    .insert({ store_connection_id: lease.connectionId, topic, ...values });
  if (!inserted.error) {
    return 'written';
  }
  if (inserted.error.code !== '23505') {
    return 'error';
  }

  // La ligne existe. Créée concurremment par un détenteur plus ancien : l'UPDATE passe. Écrite par
  // un successeur : il ne trouve toujours rien, et l'écrivain est périmé.
  const retried = await conditionalUpdate();
  if (retried.error) {
    return 'error';
  }
  return (retried.data ?? []).length > 0 ? 'written' : 'fenced';
}

const WEBHOOK_SUBSCRIPTION_CREATE = `#graphql
  mutation WebhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      webhookSubscription { id topic apiVersion { handle } }
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

type CreateResponse = {
  webhookSubscriptionCreate: {
    webhookSubscription: { id: string; apiVersion?: { handle?: string | null } | null } | null;
    userErrors: Array<{ message: string }>;
  };
};

type DeleteResponse = {
  webhookSubscriptionDelete: {
    deletedWebhookSubscriptionId: string | null;
    userErrors: Array<{ message: string }>;
  };
};

type ShopRow = {
  id: string;
  shop_domain: string;
  merchant_account_id: string;
  shopify_client_id: string | null;
  status: string;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  access_token_expires_at: string | null;
  refresh_token_expires_at: string | null;
};

type PassContext = {
  admin: AdminClient;
  deps: WebhookReconcileDeps;
  lease: ReconcileLease;
  baseOrigin: string;
  declaredMode: WebhookTokenRotationMode;
  execute: WebhookGraphQLExecutor;
};

function recognitionContext(baseOrigin: string, row: WebhookTokenRow | null) {
  // Un jeton révoqué ne reconnaît plus rien : son secret ne doit pas être réutilisé.
  const usable = row !== null && row.revokedAt === null;
  return {
    baseOrigin,
    publicId: row?.publicId ?? null,
    currentSecretHash: usable ? row.secretHash : null,
    previousSecretHash: usable ? row.previousSecretHash : null,
    verifySecret: verifyWebhookTokenSecret,
  };
}

function failure(reason: WebhookReconcileFailureReason): WebhookReconcileResult {
  return { ok: false, reason };
}

// Une passe complète sous bail. Un 401 de Shopify REMONTE (jamais avalé) : l'appelant rejoue la
// passe une fois avec un jeton plus récent ; la passe est idempotente par construction.
async function reconcilePass(context: PassContext): Promise<WebhookReconcileResult> {
  const { admin, deps, lease, baseOrigin, execute } = context;

  const tokenRead = await readWebhookToken(admin, lease.connectionId);
  if (!tokenRead.ok) {
    return failure('token_read_failed');
  }
  const tokenRow = tokenRead.row;

  // (1) Inventaire et reconnaissance.
  let classified: ClassifiedSubscription[];
  try {
    classified = classifySubscriptions(
      await listWebhookSubscriptions(execute),
      recognitionContext(baseOrigin, tokenRow),
    );
  } catch (error) {
    if (isShopifyUnauthorizedError(error)) throw error;
    return failure('inventory_failed');
  }

  const current = classified.filter(
    (subscription) => subscription.classification.kind === 'current',
  );
  const previous = classified.filter(
    (subscription) => subscription.classification.kind === 'previous',
  );
  const foreign = classified.filter(
    (subscription) => subscription.classification.kind === 'foreign',
  );
  const hasForeignOnOurOrigin = foreign.some(
    (subscription) =>
      subscription.classification.kind === 'foreign' && subscription.classification.onOurOrigin,
  );

  // (2) / (3) `uri` cible.
  const reusable = current.find((subscription) => subscription.uri !== null);
  let targetUri: string;
  let tokenPublicId: string;
  let rotated = false;
  let rotationMode: WebhookTokenRotationMode | null = null;

  if (reusable?.uri && tokenRow) {
    // Au moins un abonnement courant : son `uri` est réutilisée, sans rotation.
    targetUri = reusable.uri;
    tokenPublicId = tokenRow.publicId;
  } else {
    // Aucun abonnement courant : rotation LOCALE D'ABORD, sous bail revérifié.
    rotationMode = resolveRotationMode(context.declaredMode, {
      hasPrevious: previous.length > 0,
      hasForeignOnOurOrigin,
    });
    if (!(await leaseStillHeld(admin, lease, deps))) {
      return failure('lease_lost');
    }
    const provisioned = tokenRow
      ? await rotateWebhookToken(admin, {
          row: tokenRow,
          mode: rotationMode,
          keepPreviousInGrace: previous.length > 0,
        })
      : await createWebhookToken(admin, lease.connectionId);
    if (!provisioned.ok) {
      return failure(provisioned.reason === 'conflict' ? 'token_conflict' : 'token_write_failed');
    }
    targetUri = buildIngestUri(baseOrigin, provisioned.token.publicId, provisioned.token.secret);
    tokenPublicId = provisioned.token.publicId;
    rotated = true;
  }

  // Topics attendus.
  let created = 0;
  let duplicates = 0;
  let versionDrift = false;
  let failedTopics = 0;

  const recordState = async (
    topic: ShopifyWebhookTopic,
    fields: Omit<StateFields, 'tokenPublicId'>,
  ) => writeSubscriptionState(admin, lease, topic.rest, { tokenPublicId, ...fields });

  for (const topic of PER_SHOP_SUBSCRIPTION_TOPICS) {
    const existing = rotated ? [] : current.filter((s) => s.topic === topic.graphql);

    if (existing.length > 0) {
      duplicates += existing.length - 1;
      if (existing[0].apiVersion && existing[0].apiVersion !== SHOPIFY_API_VERSION) {
        versionDrift = true;
      }
      // Divergence corrigée : l'état reprend l'identifiant et la version OBSERVÉS.
      const outcome = await recordState(topic, {
        status: 'active',
        subscriptionId: existing[0].id,
        apiVersion: existing[0].apiVersion,
        errorCode: null,
      });
      if (outcome === 'fenced') return failure('lease_lost');
      if (outcome === 'error') return failure('state_write_failed');
      continue;
    }

    // Intention consignée AVANT l'appel : une interruption entre la création chez Shopify et la
    // sauvegarde locale laisse `pending`, que la reprise fera converger par reconnaissance.
    const intent = await recordState(topic, {
      status: 'pending',
      subscriptionId: null,
      apiVersion: null,
      errorCode: null,
    });
    if (intent === 'fenced') return failure('lease_lost');
    if (intent === 'error') return failure('state_write_failed');

    if (!(await leaseStillHeld(admin, lease, deps))) {
      return failure('lease_lost');
    }

    let errorCode: string | null = null;
    let createdSubscription: { id: string; apiVersion: string | null } | null = null;
    try {
      const data = await execute<CreateResponse>(WEBHOOK_SUBSCRIPTION_CREATE, {
        topic: topic.graphql,
        webhookSubscription: { uri: targetUri },
      });
      const payload = data.webhookSubscriptionCreate;
      if (payload.userErrors.length > 0 || !payload.webhookSubscription) {
        // Le message de Shopify peut reprendre l'`uri` : il n'est ni consigné ni journalisé.
        errorCode = 'shopify_user_error';
      } else {
        createdSubscription = {
          id: payload.webhookSubscription.id,
          apiVersion: payload.webhookSubscription.apiVersion?.handle ?? null,
        };
      }
    } catch (error) {
      if (isShopifyUnauthorizedError(error)) throw error;
      errorCode = 'shopify_request_failed';
    }

    if (!createdSubscription) {
      failedTopics += 1;
      const outcome = await recordState(topic, {
        status: 'failed',
        subscriptionId: null,
        apiVersion: null,
        errorCode: errorCode ?? 'shopify_request_failed',
      });
      if (outcome === 'fenced') return failure('lease_lost');
      if (outcome === 'error') return failure('state_write_failed');
      continue;
    }

    created += 1;
    if (createdSubscription.apiVersion && createdSubscription.apiVersion !== SHOPIFY_API_VERSION) {
      versionDrift = true;
    }
    const outcome = await recordState(topic, {
      status: 'active',
      subscriptionId: createdSubscription.id,
      apiVersion: createdSubscription.apiVersion,
      errorCode: null,
    });
    if (outcome === 'fenced') return failure('lease_lost');
    if (outcome === 'error') return failure('state_write_failed');
  }

  if (failedTopics > 0) {
    // Les abonnements précédents restent en place : ils portent encore les livraisons des topics
    // que cette passe n'a pas su recréer.
    return failure('subscription_create_failed');
  }

  // (4) Les neuf topics sont confirmés : les abonnements sur l'empreinte PRÉCÉDENTE peuvent
  // partir. Chaque suppression revérifie le bail ET relit le jeton.
  let deletedPrevious = 0;
  for (const subscription of previous) {
    if (!(await leaseStillHeld(admin, lease, deps))) {
      return failure('lease_lost');
    }
    const fresh = await readWebhookToken(admin, lease.connectionId);
    if (!fresh.ok) {
      return failure('token_read_failed');
    }
    // Une suppression ne vise jamais un abonnement COURANT au moment de la revérification.
    const freshClass = classifySubscriptionUri(
      subscription.uri,
      recognitionContext(baseOrigin, fresh.row),
    );
    if (freshClass.kind !== 'previous') {
      continue;
    }
    try {
      const data = await execute<DeleteResponse>(WEBHOOK_SUBSCRIPTION_DELETE, {
        id: subscription.id,
      });
      if (data.webhookSubscriptionDelete.userErrors.length === 0) {
        deletedPrevious += 1;
      }
    } catch (error) {
      if (isShopifyUnauthorizedError(error)) throw error;
      // Suppression non aboutie : l'abonnement sera revu à la prochaine réconciliation.
    }
  }

  if (foreign.length > 0) reportReconcileObservation('foreign_subscription');
  if (duplicates > 0) reportReconcileObservation('duplicate_subscription');
  if (versionDrift) reportReconcileObservation('api_version_drift');

  return {
    ok: true,
    rotated,
    rotationMode,
    created,
    deletedPrevious,
    foreign: foreign.length,
    duplicates,
  };
}

export async function reconcileShopifyWebhookSubscriptions(
  admin: AdminClient,
  input: WebhookReconcileInput,
  deps: WebhookReconcileDeps = defaultDeps,
): Promise<WebhookReconcileResult> {
  const fail = (reason: WebhookReconcileFailureReason): WebhookReconcileResult => {
    reportReconcileFailure(reason, input.mode);
    return failure(reason);
  };

  const baseOrigin = parseWebhookPublicBaseUrl(input.webhookBaseUrl);
  if (!baseOrigin) {
    return fail('base_url_unavailable');
  }

  const { data: shop, error: shopError } = await admin
    .from('shop')
    .select(
      'id, shop_domain, merchant_account_id, shopify_client_id, status, access_token_encrypted, refresh_token_encrypted, access_token_expires_at, refresh_token_expires_at',
    )
    .eq('id', input.shopId)
    .maybeSingle();
  if (shopError || !shop || shop.status !== 'active' || !shop.access_token_encrypted) {
    return fail('shop_unavailable');
  }
  const shopRow: ShopRow = shop;

  // La route d'ingestion refuse une connexion inactive, ou dont l'app n'est pas celle qui signe
  // les livraisons : y abonner Shopify ne produirait que des refus.
  const { data: connection, error: connectionError } = await admin
    .from('store_connection')
    .select('id, shop_id, platform_app_id, status')
    .eq('platform', 'shopify')
    .eq('external_identifier', shopRow.shop_domain)
    .maybeSingle();
  if (
    connectionError ||
    !connection ||
    connection.status !== 'active' ||
    connection.shop_id !== shopRow.id ||
    connection.platform_app_id !== input.app.clientId
  ) {
    return fail('connection_unavailable');
  }

  const acquired = await acquireReconcileLease(admin, connection.id, deps);
  if (!acquired.ok) {
    return fail(acquired.reason);
  }
  const { lease } = acquired;

  try {
    // Jeton Admin : son propre bail, pris et rendu par `getValidShopAccessToken`. Rien n'est
    // imbriqué dans le bail de réconciliation, qui porte sur une autre table et une autre clé.
    const token = await deps.getAccessToken(
      admin,
      shopRow,
      input.app.clientId,
      input.app.clientSecret,
    );
    if (!token.ok) {
      return fail('access_token_unavailable');
    }

    const result = await runWithShopifyUnauthorizedRetry(
      admin,
      shopRow,
      input.app.clientId,
      input.app.clientSecret,
      token.accessToken,
      (accessToken) =>
        reconcilePass({
          admin,
          deps,
          lease,
          baseOrigin,
          declaredMode: input.mode,
          execute: <T>(query: string, variables: Record<string, unknown>) =>
            deps.graphql<T>({
              shopDomain: shopRow.shop_domain,
              accessToken,
              query,
              variables,
              signal: AbortSignal.timeout(SHOPIFY_WEBHOOK_REQUEST_TIMEOUT_MS),
            }),
        }),
    );
    if (!result.ok) {
      reportReconcileFailure(result.reason, input.mode);
    }
    return result;
  } catch {
    // Aucun message d'erreur n'est recopié : il pourrait porter une `uri`.
    return fail('exception');
  } finally {
    await releaseReconcileLease(admin, lease);
  }
}
