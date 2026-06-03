export const SHOPIFY_API_VERSION = '2026-04';

export type ShopifyGraphQLError = {
  message: string;
  extensions?: {
    code?: string;
    [key: string]: unknown;
  };
};

export type ShopifyGraphQLResponse<T> = {
  data?: T;
  errors?: ShopifyGraphQLError[];
  extensions?: {
    cost?: unknown;
    [key: string]: unknown;
  };
};

type ShopifyGraphQLInput = {
  shopDomain: string;
  accessToken: string;
  query: string;
  variables?: Record<string, unknown>;
};

function buildGraphQLErrorMessage(errors: ShopifyGraphQLError[]): string {
  const messages = errors.map((error) => error.message).join('; ');
  const codes = errors
    .map((error) => error.extensions?.code)
    .filter((code): code is string => Boolean(code));

  if (codes.includes('THROTTLED')) {
    return `Shopify GraphQL request was throttled: ${messages}`;
  }

  if (codes.includes('ACCESS_DENIED')) {
    return `Shopify GraphQL access denied: ${messages}`;
  }

  return `Shopify GraphQL request failed: ${messages}`;
}

export async function shopifyGraphQL<T>({
  shopDomain,
  accessToken,
  query,
  variables,
}: ShopifyGraphQLInput): Promise<T> {
  const response = await fetch(
    `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  if (!response.ok) {
    throw new Error(`Shopify GraphQL HTTP request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as ShopifyGraphQLResponse<T>;

  if (payload.errors?.length) {
    throw new Error(buildGraphQLErrorMessage(payload.errors));
  }

  if (!payload.data) {
    throw new Error('Shopify GraphQL response is missing data');
  }

  return payload.data;
}
