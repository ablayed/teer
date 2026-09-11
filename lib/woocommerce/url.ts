// R2.4 / commit 3 — canonicalisation d'identité WooCommerce.
//
// Cette fonction produit une clé d'identité. Elle ne décide pas si une URL peut
// être appelée : le filtrage SSRF est une étape séparée dans ssrf.ts.

export class WooCommerceUrlError extends Error {
  readonly code = 'invalid_url' as const;

  constructor() {
    super('invalid_url');
    this.name = 'WooCommerceUrlError';
  }
}

function parseHttpsUrl(input: string): URL {
  let url: URL;

  try {
    url = new URL(input);
  } catch {
    throw new WooCommerceUrlError();
  }

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.port && url.port !== '443') ||
    !url.hostname
  ) {
    throw new WooCommerceUrlError();
  }

  return url;
}

function canonicalHostname(url: URL): string {
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');

  if (!hostname || hostname.includes('%')) {
    throw new WooCommerceUrlError();
  }

  return hostname;
}

function canonicalPath(url: URL): string {
  const path = url.pathname || '/';
  const withoutTrailingSlashes = path.replace(/\/+$/, '');
  return withoutTrailingSlashes || '/';
}

function formatHostname(hostname: string): string {
  return hostname.includes(':') ? `[${hostname}]` : hostname;
}

/**
 * Retourne la clé persistable `https://host[:port]/sous-repertoire`.
 * `www`, le sous-répertoire et le port non implicite restent significatifs.
 */
export function normalizeWooCommerceIdentity(input: string): string {
  const url = parseHttpsUrl(input);
  const hostname = canonicalHostname(url);
  const port = url.port && url.port !== '443' ? `:${url.port}` : '';

  return `https://${formatHostname(hostname)}${port}${canonicalPath(url)}`;
}

/** Analyse une destination HTTP avant le filtre réseau, sans produire de clé d'identité. */
export function parseWooCommerceRequestUrl(input: string): URL {
  let url: URL;

  try {
    url = new URL(input);
  } catch {
    throw new WooCommerceUrlError();
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.hostname) {
    throw new WooCommerceUrlError();
  }

  if (url.port && url.port !== '443') {
    throw new WooCommerceUrlError();
  }

  return url;
}
