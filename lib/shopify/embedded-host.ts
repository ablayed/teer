// APP-03 / Lot 2 — décodage/validation serveur du paramètre `host` App Bridge, et construction
// de la destination canonique Shopify Admin. Miroir serveur (Buffer) de `decodeHost` côté client
// (atob) dans `app/shopify/embedded/embedded-shopify-surface.tsx` — mêmes deux formes acceptées,
// jamais un store handle dérivé ailleurs (pas de handle d'app Shopify nécessaire : cf.
// `buildEmbeddedAppUrl` du SDK officiel `@shopify/shopify-api`, qui construit exactement
// `https://{host décodé}/apps/{client_id}`).
const MODERN_HOST_PATTERN = /^admin\.shopify\.com\/store\/[a-z0-9-]+$/i;
const LEGACY_HOST_PATTERN = /^[a-z0-9-]+\.myshopify\.com\/admin$/i;

export function decodeShopifyEmbeddedHost(host: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(host)) {
    return null;
  }

  let decoded: string;
  try {
    decoded = Buffer.from(host.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return null;
  }

  if (MODERN_HOST_PATTERN.test(decoded) || LEGACY_HOST_PATTERN.test(decoded)) {
    return decoded;
  }

  return null;
}

// `host` absent ou invalide → null, jamais de destination devinée depuis un autre paramètre
// (sous-domaine myshopify, etc.).
export function buildShopifyEmbeddedAppUrl(host: string, clientId: string): string | null {
  const decodedHost = decodeShopifyEmbeddedHost(host);

  return decodedHost ? `https://${decodedHost}/apps/${clientId}` : null;
}
