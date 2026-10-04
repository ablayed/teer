// SHOPIFY-WEBHOOKS-PER-SHOP-1B / C2 — inventaire des abonnements webhook d'une boutique et
// RECONNAISSANCE de chacun (G3, G12).
//
// Le secret du jeton L3 n'est stocké qu'en empreinte (0143). Pour savoir si un abonnement déjà
// enregistré chez Shopify vise le jeton courant, on hache le secret contenu dans l'`uri` que
// Shopify renvoie, et on compare aux empreintes courante et précédente — en mémoire, en temps
// constant, sans rien journaliser.
//
// Forme documentée (Admin GraphQL, objet WebhookSubscription) : `uri: String!`, l'URL HTTPS telle
// qu'enregistrée ; `callbackUrl` et `endpoint` sont dépréciés. `apiVersion` est hérité de l'app et
// ne se fixe pas par abonnement : il se relit, c'est tout.
//
// Module chargeable par le Node natif (scripts/webhook-subscription-migration.mjs --plan) : aucun
// import de valeur par alias. L'exécuteur GraphQL et le vérificateur d'empreinte sont INJECTÉS.

export const INGEST_PATH_PREFIX = '/api/shopify/ingest/';

// Séparateur du jeton : `publicId.secret` (lib/ingestion/webhook-token.ts).
const TOKEN_SEPARATOR = '.';

export type WebhookSubscriptionNode = {
  readonly id: string;
  // Valeur de l'enum WebhookSubscriptionTopic (ex. ORDERS_CREATE).
  readonly topic: string;
  readonly uri: string | null;
  readonly apiVersion: string | null;
};

// Exécute une requête Admin GraphQL pour LA boutique de l'appelant et rend `data`.
export type WebhookGraphQLExecutor = <T>(
  query: string,
  variables: Record<string, unknown>,
) => Promise<T>;

export const WEBHOOK_SUBSCRIPTIONS_PAGE_SIZE = 100;
// Garde-fou : une boutique ne porte que quelques abonnements par app. Au-delà de cette borne,
// l'inventaire est déclaré incomplet plutôt que tronqué en silence.
export const WEBHOOK_SUBSCRIPTIONS_MAX_PAGES = 20;

export const WEBHOOK_SUBSCRIPTIONS_QUERY = `#graphql
  query WebhookSubscriptionsInventory($first: Int!, $after: String) {
    webhookSubscriptions(first: $first, after: $after) {
      edges {
        node {
          id
          topic
          uri
          apiVersion { handle }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

type WebhookSubscriptionsPage = {
  webhookSubscriptions: {
    edges: Array<{
      node: {
        id: string;
        topic: string;
        uri?: string | null;
        apiVersion?: { handle?: string | null } | null;
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

// Inventaire PAGINÉ. La query ne rend que les abonnements créés par l'API pour l'app et la
// boutique courantes : un abonnement déclaré dans le TOML de l'app lui est invisible.
export async function listWebhookSubscriptions(
  execute: WebhookGraphQLExecutor,
): Promise<WebhookSubscriptionNode[]> {
  const nodes: WebhookSubscriptionNode[] = [];
  let after: string | null = null;

  for (let page = 0; page < WEBHOOK_SUBSCRIPTIONS_MAX_PAGES; page += 1) {
    const data: WebhookSubscriptionsPage = await execute<WebhookSubscriptionsPage>(
      WEBHOOK_SUBSCRIPTIONS_QUERY,
      { first: WEBHOOK_SUBSCRIPTIONS_PAGE_SIZE, after },
    );
    const connection = data.webhookSubscriptions;

    for (const { node } of connection.edges) {
      nodes.push({
        id: node.id,
        topic: node.topic,
        uri: typeof node.uri === 'string' ? node.uri : null,
        apiVersion: node.apiVersion?.handle ?? null,
      });
    }

    if (!connection.pageInfo.hasNextPage) {
      return nodes;
    }
    if (!connection.pageInfo.endCursor) {
      throw new Error('shopify_webhook_inventory_cursor_missing');
    }
    after = connection.pageInfo.endCursor;
  }

  throw new Error('shopify_webhook_inventory_too_large');
}

export type SubscriptionRecognitionContext = {
  // Origine de WEBHOOK_PUBLIC_BASE_URL (ex. https://webhooks.example.test).
  readonly baseOrigin: string;
  // Identifiant public du jeton de la connexion. NULL : aucun jeton local, rien n'est reconnu.
  readonly publicId: string | null;
  readonly currentSecretHash: string | null;
  readonly previousSecretHash: string | null;
  // Comparaison en temps constant de l'empreinte du secret (lib/ingestion/webhook-token.ts,
  // `verifyWebhookTokenSecret`).
  readonly verifySecret: (secret: string, storedHash: string) => boolean;
};

export type SubscriptionClass =
  // Vise le jeton COURANT de cette connexion : seule classe dont l'`uri` peut être réutilisée.
  | { readonly kind: 'current' }
  // Vise l'empreinte PRÉCÉDENTE de cette connexion (rotation antérieure).
  | { readonly kind: 'previous' }
  // Tout le reste. `onOurOrigin` : l'abonnement vise notre origine sans être reconnu — des
  // livraisons arrivent donc chez nous sur une URL que nous ne reconnaissons plus.
  | { readonly kind: 'foreign'; readonly onOurOrigin: boolean };

// Une `uri` n'est `current` ou `previous` que si les QUATRE conditions sont réunies :
//   1. origine égale à celle de WEBHOOK_PUBLIC_BASE_URL ;
//   2. chemin égal à /api/shopify/ingest/ suivi d'un seul segment ;
//   3. `publicId` égal à celui du jeton de la connexion ;
//   4. empreinte du secret égale, en temps constant, à l'empreinte courante (ou précédente).
// Une bonne empreinte sur une autre origine, un autre chemin ou un autre `publicId` reste
// `foreign` : une empreinte seule ne prouve pas que l'abonnement livre chez nous, pour CETTE
// connexion.
export function classifySubscriptionUri(
  uri: string | null,
  context: SubscriptionRecognitionContext,
): SubscriptionClass {
  if (!uri) {
    return { kind: 'foreign', onOurOrigin: false };
  }

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return { kind: 'foreign', onOurOrigin: false };
  }

  // (1) Origine.
  if (parsed.origin !== context.baseOrigin) {
    return { kind: 'foreign', onOurOrigin: false };
  }
  const foreignHere: SubscriptionClass = { kind: 'foreign', onOurOrigin: true };

  // (2) Chemin : le préfixe, puis un seul segment, sans requête ni fragment.
  if (!parsed.pathname.startsWith(INGEST_PATH_PREFIX) || parsed.search || parsed.hash) {
    return foreignHere;
  }
  const tokenSegment = parsed.pathname.slice(INGEST_PATH_PREFIX.length);
  if (!tokenSegment || tokenSegment.includes('/')) {
    return foreignHere;
  }

  const separatorIndex = tokenSegment.indexOf(TOKEN_SEPARATOR);
  if (separatorIndex <= 0 || separatorIndex === tokenSegment.length - 1) {
    return foreignHere;
  }
  const publicId = tokenSegment.slice(0, separatorIndex);
  const secret = tokenSegment.slice(separatorIndex + 1);

  // (3) Identifiant public.
  if (!context.publicId || publicId !== context.publicId) {
    return foreignHere;
  }

  // (4) Empreinte. Les deux comparaisons sont toujours faites : le temps ne dit pas laquelle a
  // réussi.
  const matchesCurrent = context.currentSecretHash
    ? context.verifySecret(secret, context.currentSecretHash)
    : false;
  const matchesPrevious = context.previousSecretHash
    ? context.verifySecret(secret, context.previousSecretHash)
    : false;

  if (matchesCurrent) {
    return { kind: 'current' };
  }
  if (matchesPrevious) {
    return { kind: 'previous' };
  }
  return foreignHere;
}

export type ClassifiedSubscription = WebhookSubscriptionNode & {
  readonly classification: SubscriptionClass;
};

export function classifySubscriptions(
  subscriptions: readonly WebhookSubscriptionNode[],
  context: SubscriptionRecognitionContext,
): ClassifiedSubscription[] {
  return subscriptions.map((subscription) => ({
    ...subscription,
    classification: classifySubscriptionUri(subscription.uri, context),
  }));
}

// Masquage, pour TOUTE sortie de diagnostic : une `uri` d'ingestion porte le secret du jeton dans
// son chemin. Ce qui suit le préfixe est remplacé ; une autre `uri` est réduite à son origine et
// son chemin (jamais sa requête) ; une valeur illisible n'est pas recopiée.
export function maskSubscriptionUri(uri: string | null | undefined): string {
  if (typeof uri !== 'string' || uri.length === 0) {
    return '<absente>';
  }
  const index = uri.indexOf(INGEST_PATH_PREFIX);
  if (index !== -1) {
    return `${uri.slice(0, index)}${INGEST_PATH_PREFIX}***`;
  }
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return `${parsed.protocol}***`;
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '<uri illisible>';
  }
}

// Origine de WEBHOOK_PUBLIC_BASE_URL, ou NULL si la valeur est absente ou inutilisable : HTTPS
// exigé, sans slash final, sans chemin, sans requête. Aucune valeur par défaut.
export function parseWebhookPublicBaseUrl(raw: string | null | undefined): string | null {
  if (!raw || raw.endsWith('/')) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.origin !== raw) {
    return null;
  }
  return parsed.origin;
}

export function buildIngestUri(baseOrigin: string, publicId: string, secret: string): string {
  return `${baseOrigin}${INGEST_PATH_PREFIX}${publicId}${TOKEN_SEPARATOR}${secret}`;
}
