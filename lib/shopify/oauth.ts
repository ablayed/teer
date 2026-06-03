import { createHmac, timingSafeEqual } from 'node:crypto';

export type TokenResponse = {
  accessToken: string;
  scope: string;
  refreshToken?: string;
  accessTokenExpiresAt?: Date;
  refreshTokenExpiresAt?: Date;
};

type BuildAuthorizeUrlInput = {
  shop: string;
  clientId: string;
  redirectUri: string;
  state: string;
};

export const SHOPIFY_REQUIRED_SCOPES = ['read_orders', 'read_customers', 'read_products'] as const;

type ExchangeCodeForTokenInput = {
  shop: string;
  clientId: string;
  clientSecret: string;
  code: string;
};

const shopDomainPattern = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

export function validateShopDomain(shop: string): boolean {
  return shopDomainPattern.test(shop);
}

export function buildAuthorizeUrl({
  shop,
  clientId,
  redirectUri,
  state,
}: BuildAuthorizeUrlInput): string {
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', SHOPIFY_REQUIRED_SCOPES.join(','));

  return url.toString();
}

export function hasShopifyScope(scopes: string | null | undefined, scope: string): boolean {
  if (!scopes) {
    return false;
  }

  return scopes
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(scope);
}

function buildOAuthHmacMessage(searchParams: URLSearchParams): string {
  return Array.from(searchParams.entries())
    .filter(([key]) => key !== 'hmac' && key !== 'signature')
    .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

export function verifyOAuthHmac(searchParams: URLSearchParams, secret: string): boolean {
  const hmac = searchParams.get('hmac');

  if (!hmac || !/^[0-9a-f]+$/i.test(hmac) || hmac.length % 2 !== 0) {
    return false;
  }

  const digest = createHmac('sha256', secret).update(buildOAuthHmacMessage(searchParams)).digest();
  const provided = Buffer.from(hmac, 'hex');

  return provided.length === digest.length && timingSafeEqual(provided, digest);
}

function readStringProperty(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumberProperty(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function expirationDateFromSeconds(expiresIn: number | undefined): Date | undefined {
  if (expiresIn === undefined) {
    return undefined;
  }

  return new Date(Date.now() + expiresIn * 1000);
}

export async function exchangeCodeForToken({
  shop,
  clientId,
  clientSecret,
  code,
}: ExchangeCodeForTokenInput): Promise<TokenResponse> {
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });

  if (!response.ok) {
    throw new Error(`Shopify token exchange failed with status ${response.status}`);
  }

  const payload: unknown = await response.json();

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Shopify token exchange response is invalid');
  }

  const record = payload as Record<string, unknown>;
  const accessToken = readStringProperty(record, 'access_token');
  const scope = readStringProperty(record, 'scope');

  if (!accessToken) {
    throw new Error('Shopify token exchange response is missing access_token');
  }

  if (!scope) {
    throw new Error('Shopify token exchange response is missing scope');
  }

  return {
    accessToken,
    scope,
    refreshToken: readStringProperty(record, 'refresh_token'),
    accessTokenExpiresAt: expirationDateFromSeconds(readNumberProperty(record, 'expires_in')),
    refreshTokenExpiresAt: expirationDateFromSeconds(
      readNumberProperty(record, 'refresh_token_expires_in'),
    ),
  };
}
