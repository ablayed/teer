import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ShopifyAppDistribution } from '@/lib/shopify/app-registry-sources';

// SHOPIFY-EXPIRING-TOKENS-01 §3 — seule règle de décision de `expiring=1`, sur les DEUX chemins
// d'acquisition (échange de code et échange par ID token). Shopify n'exige les jetons expirants
// que des apps PUBLIQUES ; une app custom en est exclue. Le risque n'est pas symétrique : poser
// `expiring=1` sur une app custom (KOBA) ferait expirer les jetons du seul marchand réel.
export function requestsExpiringOfflineToken(distribution: ShopifyAppDistribution): boolean {
  return distribution === 'public';
}

// SHOPIFY-EXPIRING-TOKENS-01 §9 — borne réseau des trois appels au endpoint de jeton. Avant ce
// lot, aucune : le délai effectif était celui d'undici (300 s d'en-têtes), c'est-à-dire la durée
// maximale de la fonction elle-même. Ces appels sont désormais tenus SOUS BAIL
// (lib/shopify/token-lease.ts) ; c'est cette borne qui rend la durée d'une opération sous bail
// inférieure au TTL sans renouvellement. Durée observée d'un échange réel : 2,86 s (Test A,
// docs/shopify/TEST-NONEMBED-A-RESULTAT-2026-09-21.md) — marge d'un facteur 7.
export const SHOPIFY_TOKEN_REQUEST_TIMEOUT_MS = 20_000;

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
  // Obligatoire : l'appelant ne choisit pas `expiring`, il déclare la distribution de l'app.
  distribution: ShopifyAppDistribution;
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

type RefreshTokenInput = {
  shop: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

// Parse la réponse du endpoint token (échange code OU refresh) en TokenResponse.
// Pour un token offline expirant, Shopify renvoie expires_in + refresh_token (+ expiry).
function parseTokenResponse(payload: unknown): TokenResponse {
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

export async function exchangeCodeForToken({
  shop,
  clientId,
  clientSecret,
  code,
  distribution,
}: ExchangeCodeForTokenInput): Promise<TokenResponse> {
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      ...(requestsExpiringOfflineToken(distribution) ? { expiring: '1' } : {}),
    }),
    signal: AbortSignal.timeout(SHOPIFY_TOKEN_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Shopify token exchange failed with status ${response.status}`);
  }

  return parseTokenResponse(await response.json());
}

// Renouvelle un access token offline expirant via le refresh token (grant_type=refresh_token).
// Renvoie le nouveau couple access/refresh + expirations. Lève si le refresh est refusé
// (ex. refresh token expiré → re-OAuth nécessaire). Aucun token n'est journalisé ici.
export async function refreshAccessToken({
  shop,
  clientId,
  clientSecret,
  refreshToken,
}: RefreshTokenInput): Promise<TokenResponse> {
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(SHOPIFY_TOKEN_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Shopify token refresh failed with status ${response.status}`);
  }

  return parseTokenResponse(await response.json());
}

type ExchangeIdTokenForOfflineTokenInput = {
  shop: string;
  clientId: string;
  clientSecret: string;
  idToken: string;
  // Obligatoire, comme pour exchangeCodeForToken : ce chemin est atteignable par une app custom
  // (teer-dev est déclarée `embedded = true`), il n'est donc pas réservé à une app publique.
  distribution: ShopifyAppDistribution;
};

// APP-03 / Lot 2 — additif : token exchange (RFC 8693) pour obtenir un access token OFFLINE
// depuis l'ID token de session (App Bridge). `shop` est déjà un domaine complet validé
// (xxx.myshopify.com) — jamais reconstruit ici. `expiring=1` n'est posé QUE pour une app
// publique (SHOPIFY-EXPIRING-TOKENS-01 §3) : sans lui, Shopify renvoie un token OFFLINE non
// expirant, sans refresh_token — le régime voulu pour une app custom. Avant ce lot, il était
// posé inconditionnellement, et imposait le régime expirant à une app custom embarquée.
export async function exchangeIdTokenForOfflineToken({
  shop,
  clientId,
  clientSecret,
  idToken,
  distribution,
}: ExchangeIdTokenForOfflineTokenInput): Promise<TokenResponse> {
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: idToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      ...(requestsExpiringOfflineToken(distribution) ? { expiring: '1' } : {}),
    }),
    signal: AbortSignal.timeout(SHOPIFY_TOKEN_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Shopify token exchange (id_token) failed with status ${response.status}`);
  }

  return parseTokenResponse(await response.json());
}
