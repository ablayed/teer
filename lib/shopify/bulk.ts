// Bulk Operations Shopify pour la sync des commandes (Phase 7a).
// bulkOperationRunQuery → JSONL → réassemblage parent/enfant via __parentId.
// Utilisé par la réconciliation nocturne et le webhook bulk_operations/finish (fallback polling).

import { shopifyGraphQL } from '@/lib/shopify/graphql';
import type { ShopifyOrderNode } from '@/lib/shopify/orders-sync';

// La query bulk ne pagine pas (le bulk gère tout) ; les connexions imbriquées (lineItems)
// sont aplaties en lignes JSONL séparées portant __parentId. `query:` filtre par date de MAJ.
export function buildBulkOrdersQuery(updatedSinceIso: string | null): string {
  const filter = updatedSinceIso ? `query: "updated_at:>='${updatedSinceIso}'"` : '';
  return `
{
  orders(${filter ? `${filter}, ` : ''}sortKey: UPDATED_AT) {
    edges {
      node {
        __typename
        id
        name
        createdAt
        updatedAt
        cancelledAt
        displayFinancialStatus
        displayFulfillmentStatus
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        customer { id displayName phone email }
        shippingAddress { address1 address2 city province country zip phone name }
        lineItems {
          edges {
            node {
              __typename
              title
              sku
              quantity
              originalUnitPriceSet { shopMoney { amount } }
              variant { id }
              product { id }
            }
          }
        }
      }
    }
  }
}`.trim();
}

const BULK_RUN_MUTATION = `
mutation bulkOrders($query: String!) {
  bulkOperationRunQuery(query: $query) {
    bulkOperation { id status }
    userErrors { field message }
  }
}`;

const CURRENT_BULK_OPERATION_QUERY = `
{
  currentBulkOperation(type: QUERY) {
    id
    status
    errorCode
    objectCount
    url
  }
}`;

export type BulkOperation = {
  id: string;
  status: string;
  errorCode: string | null;
  objectCount: string | null;
  url: string | null;
};

type BulkRunResponse = {
  bulkOperationRunQuery: {
    bulkOperation: { id: string; status: string } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
};

type CurrentBulkResponse = { currentBulkOperation: BulkOperation | null };

// Lance une bulk operation pour les commandes modifiées depuis `updatedSinceIso` (ou tout).
export async function startBulkOrdersOperation(
  shopDomain: string,
  accessToken: string,
  updatedSinceIso: string | null,
): Promise<{ id: string; status: string }> {
  const data = await shopifyGraphQL<BulkRunResponse>({
    shopDomain,
    accessToken,
    query: BULK_RUN_MUTATION,
    variables: { query: buildBulkOrdersQuery(updatedSinceIso) },
  });

  const userErrors = data.bulkOperationRunQuery.userErrors;
  if (userErrors.length > 0) {
    throw new Error(
      `bulkOperationRunQuery userErrors: ${userErrors.map((e) => e.message).join('; ')}`,
    );
  }

  const op = data.bulkOperationRunQuery.bulkOperation;
  if (!op) {
    throw new Error('bulkOperationRunQuery returned no operation');
  }
  return op;
}

export async function pollBulkOperation(
  shopDomain: string,
  accessToken: string,
): Promise<BulkOperation | null> {
  const data = await shopifyGraphQL<CurrentBulkResponse>({
    shopDomain,
    accessToken,
    query: CURRENT_BULK_OPERATION_QUERY,
  });
  return data.currentBulkOperation;
}

// Fallback polling : la livraison du webhook bulk_operations/finish n'est PAS garantie.
// Interroge l'opération jusqu'à COMPLETED/échec ou expiration de la fenêtre.
export async function waitForBulkCompletion(
  shopDomain: string,
  accessToken: string,
  { maxAttempts = 30, delayMs = 2_000 }: { maxAttempts?: number; delayMs?: number } = {},
): Promise<BulkOperation> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const op = await pollBulkOperation(shopDomain, accessToken);
    if (op && op.status !== 'RUNNING' && op.status !== 'CREATED') {
      return op;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error('bulk operation did not complete within the polling window');
}

// Télécharge le JSONL (URL de stockage signée). 429 → backoff exponentiel honorant Retry-After.
export async function downloadJsonl(url: string, { maxRetries = 4 } = {}): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url);
    if (response.status === 429 && attempt < maxRetries) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : 2 ** attempt * 1_000;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    if (!response.ok) {
      throw new Error(`bulk JSONL download failed with status ${response.status}`);
    }
    return response.text();
  }
}

type RawBulkLine = Record<string, unknown> & {
  id?: string;
  __parentId?: string;
  __typename?: string;
};

function str(record: Record<string, unknown>, key: string): string | null {
  const v = record[key];
  return typeof v === 'string' ? v : null;
}

function moneyAmount(node: Record<string, unknown>, key: string): string {
  const set = node[key];
  if (set && typeof set === 'object') {
    const shopMoney = (set as Record<string, unknown>).shopMoney;
    if (shopMoney && typeof shopMoney === 'object') {
      const amount = (shopMoney as Record<string, unknown>).amount;
      if (typeof amount === 'string') return amount;
    }
  }
  return '0';
}

// Réassemble le JSONL bulk en ShopifyOrderNode[] : les lignes sans __parentId sont des Order,
// celles avec __parentId sont des enfants (LineItem) rattachés à leur commande parente.
export function parseBulkOrdersJsonl(jsonl: string): ShopifyOrderNode[] {
  const orders = new Map<string, ShopifyOrderNode>();
  const lineItemsByParent = new Map<string, ShopifyOrderNode['lineItems']['edges']>();

  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: RawBulkLine;
    try {
      parsed = JSON.parse(trimmed) as RawBulkLine;
    } catch {
      continue;
    }

    const parentId = parsed.__parentId;
    if (parentId) {
      // Enfant = LineItem.
      const variant = parsed.variant as Record<string, unknown> | null;
      const product = parsed.product as Record<string, unknown> | null;
      const edge = {
        node: {
          title: str(parsed, 'title') ?? '',
          sku: str(parsed, 'sku'),
          quantity: typeof parsed.quantity === 'number' ? parsed.quantity : 0,
          originalUnitPriceSet: {
            shopMoney: { amount: moneyAmount(parsed, 'originalUnitPriceSet') },
          },
          variant: variant && typeof variant.id === 'string' ? { id: variant.id } : null,
          product: product && typeof product.id === 'string' ? { id: product.id } : null,
        },
      };
      const list = lineItemsByParent.get(parentId) ?? [];
      list.push(edge);
      lineItemsByParent.set(parentId, list);
      continue;
    }

    const id = parsed.id;
    if (!id) continue;
    const customer = parsed.customer as Record<string, unknown> | null;
    const shippingAddress = parsed.shippingAddress as Record<string, unknown> | null;
    const money = parsed.currentTotalPriceSet as Record<string, unknown> | null;
    const currencyCode =
      money && typeof money === 'object'
        ? ((money.shopMoney as Record<string, unknown> | null)?.currencyCode as string | undefined)
        : undefined;

    orders.set(id, {
      id,
      name: str(parsed, 'name') ?? id,
      createdAt: str(parsed, 'createdAt'),
      updatedAt: str(parsed, 'updatedAt'),
      cancelledAt: str(parsed, 'cancelledAt'),
      displayFinancialStatus: str(parsed, 'displayFinancialStatus'),
      displayFulfillmentStatus: str(parsed, 'displayFulfillmentStatus'),
      currentTotalPriceSet: {
        shopMoney: { amount: moneyAmount(parsed, 'currentTotalPriceSet'), currencyCode },
      },
      customer:
        customer && typeof customer.id === 'string'
          ? {
              id: customer.id,
              displayName: (customer.displayName as string | null) ?? null,
              phone: (customer.phone as string | null) ?? null,
              email: (customer.email as string | null) ?? null,
            }
          : null,
      shippingAddress: shippingAddress
        ? {
            address1: (shippingAddress.address1 as string | null) ?? null,
            address2: (shippingAddress.address2 as string | null) ?? null,
            city: (shippingAddress.city as string | null) ?? null,
            province: (shippingAddress.province as string | null) ?? null,
            country: (shippingAddress.country as string | null) ?? null,
            zip: (shippingAddress.zip as string | null) ?? null,
            phone: (shippingAddress.phone as string | null) ?? null,
            name: (shippingAddress.name as string | null) ?? null,
          }
        : null,
      lineItems: { edges: [] },
    });
  }

  // Rattache les enfants à leur commande parente.
  for (const [parentId, edges] of lineItemsByParent) {
    const order = orders.get(parentId);
    if (order) {
      order.lineItems.edges = edges;
    }
  }

  return [...orders.values()];
}
