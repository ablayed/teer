// R2.4 / commit 3 — client REST WooCommerce.
//
// Le transport ne suit jamais les redirections automatiquement. Le resolver
// valide l'ensemble A/AAAA, puis le socket HTTPS est épinglé à l'adresse
// validée ; le hostname original reste utilisé pour Host et SNI.

import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import {
  type DnsResolver,
  type PinnedHttpsTarget,
  WOO_MAX_REDIRECTS,
  WOO_MAX_RESPONSE_BYTES,
  WOO_REQUEST_TIMEOUT_MS,
  WooCommerceSsrfError,
  resolveAllAddresses,
  validateAndPinHttpsTarget,
} from '@/lib/woocommerce/ssrf';
import { normalizeWooCommerceIdentity, parseWooCommerceRequestUrl } from '@/lib/woocommerce/url';

export type WooCommerceErrorCode =
  | 'invalid_url'
  | 'ssrf_rejected'
  | 'dns_failed'
  | 'timeout'
  | 'response_too_large'
  | 'response_not_json'
  | 'invalid_json'
  | 'redirect_rejected'
  | 'redirect_limit_exceeded'
  | 'credentials_invalid'
  | 'woocommerce_authentication_error'
  | 'woocommerce_access_denied'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'upstream_error'
  | 'identity_mismatch'
  | 'identity_missing';

export class WooCommerceClientError extends Error {
  readonly code: WooCommerceErrorCode;
  readonly status: number | null;

  constructor(code: WooCommerceErrorCode, status: number | null = null) {
    super(code);
    this.name = 'WooCommerceClientError';
    this.code = code;
    this.status = status;
  }
}

export type WooCommerceHttpResponse = {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
};

export type WooCommerceTransport = (
  target: PinnedHttpsTarget,
  headers: Readonly<Record<string, string>>,
  deadline: number,
) => Promise<WooCommerceHttpResponse>;

export type PinnedLookup = (
  hostname: string,
  options: object,
  callback: (error: NodeJS.ErrnoException | null, address: string, family: 4 | 6) => void,
) => void;

/** Le socket ignore le nom résolu une seconde fois et utilise l'adresse validée. */
export function createPinnedLookup(target: PinnedHttpsTarget): PinnedLookup {
  return (_hostname, _options, callback) => {
    callback(null, target.address.address, target.address.family);
  };
}

type WooCommerceClientOptions = {
  readonly baseUrl: string;
  readonly consumerKey: string;
  readonly consumerSecret: string;
  readonly resolver?: DnsResolver;
  readonly transport?: WooCommerceTransport;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxRedirects?: number;
};

export type WooCommerceIdentityProof = {
  readonly claimedIdentity: string;
  readonly canonicalIdentity: string;
  readonly restUrl: string;
  readonly homeUrl: string;
};

function remaining(deadline: number): number {
  const value = deadline - Date.now();
  if (value <= 0) {
    throw new WooCommerceClientError('timeout');
  }
  return value;
}

function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const timeout = remaining(deadline);

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new WooCommerceClientError('timeout')), timeout);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function readWooCommerceBody(
  response: IncomingMessage,
  maxResponseBytes: number,
  deadline: number,
): Promise<string> {
  const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase();
  const decoder =
    encoding === 'gzip'
      ? createGunzip()
      : encoding === 'deflate'
        ? createInflate()
        : encoding === 'br'
          ? createBrotliDecompress()
          : null;
  const bodyStream = decoder ? response.pipe(decoder) : response;
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    for await (const chunk of bodyStream) {
      remaining(deadline);
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxResponseBytes) {
        throw new WooCommerceClientError('response_too_large');
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof WooCommerceClientError) {
      throw error;
    }
    throw new WooCommerceClientError('upstream_error');
  }

  return Buffer.concat(chunks).toString('utf8');
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function isJsonResponse(headers: IncomingHttpHeaders): boolean {
  const contentType = headerValue(headers, 'content-type')?.toLowerCase() ?? '';
  return contentType.startsWith('application/json') || contentType.includes('+json');
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new WooCommerceClientError('invalid_json');
  }
}

function responseCode(status: number, body: unknown): WooCommerceErrorCode {
  if (status === 401) {
    return 'credentials_invalid';
  }
  if (status === 403) {
    return 'woocommerce_access_denied';
  }
  if (status === 429) {
    return 'rate_limited';
  }
  if (status >= 500) {
    return 'upstream_unavailable';
  }

  const code =
    typeof body === 'object' && body !== null && 'code' in body && typeof body.code === 'string'
      ? body.code
      : '';

  if (code === 'woocommerce_rest_authentication_error') {
    return 'woocommerce_authentication_error';
  }
  if (code === 'woocommerce_rest_cannot_view' || code === 'woocommerce_rest_cannot_create') {
    return 'woocommerce_access_denied';
  }
  return 'upstream_error';
}

/** Classification sans propagation du message WooCommerce ou du corps fournisseur. */
export function classifyWooCommerceResponse(
  status: number,
  body: unknown,
): { readonly ok: true } | { readonly ok: false; readonly code: WooCommerceErrorCode } {
  if (status >= 200 && status < 300) {
    return { ok: true };
  }
  return { ok: false, code: responseCode(status, body) };
}

function joinBasePath(baseUrl: string, relativePath: string): string {
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/+$/, '');
  return new URL(`${prefix}/${relativePath.replace(/^\/+/, '')}`, base.origin).toString();
}

async function requestPinnedHttps(
  target: PinnedHttpsTarget,
  headers: Readonly<Record<string, string>>,
  deadline: number,
  maxResponseBytes: number,
): Promise<WooCommerceHttpResponse> {
  return withDeadline(
    new Promise<WooCommerceHttpResponse>((resolve, reject) => {
      const request = httpsRequest(
        {
          protocol: 'https:',
          hostname: target.hostname,
          port: target.port,
          path: `${target.url.pathname}${target.url.search}`,
          method: 'GET',
          headers,
          agent: false,
          servername: target.hostname,
          timeout: Math.max(1, remaining(deadline)),
          lookup: createPinnedLookup(target),
        },
        (response) => {
          void readWooCommerceBody(response, maxResponseBytes, deadline).then(
            (body) =>
              resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
            (error: unknown) => {
              request.destroy();
              reject(error);
            },
          );
        },
      );

      request.once('timeout', () => {
        request.destroy();
        reject(new WooCommerceClientError('timeout'));
      });
      request.once('error', () => reject(new WooCommerceClientError('upstream_error')));
      request.end();
    }),
    deadline,
  );
}

export class WooCommerceClient {
  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly resolver: DnsResolver;
  private readonly transport: WooCommerceTransport;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxRedirects: number;

  constructor(options: WooCommerceClientOptions) {
    try {
      this.baseUrl = normalizeWooCommerceIdentity(options.baseUrl);
    } catch {
      throw new WooCommerceClientError('invalid_url');
    }

    if (!options.consumerKey || !options.consumerSecret) {
      throw new WooCommerceClientError('credentials_invalid');
    }

    this.authorization = `Basic ${Buffer.from(`${options.consumerKey}:${options.consumerSecret}`).toString('base64')}`;
    this.resolver = options.resolver ?? resolveAllAddresses;
    this.timeoutMs = options.timeoutMs ?? WOO_REQUEST_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? WOO_MAX_RESPONSE_BYTES;
    this.maxRedirects = options.maxRedirects ?? WOO_MAX_REDIRECTS;
    this.transport =
      options.transport ??
      ((target, headers, deadline) =>
        requestPinnedHttps(target, headers, deadline, this.maxResponseBytes));
  }

  async readJson(relativePath: string): Promise<unknown> {
    const deadline = Date.now() + this.timeoutMs;
    let currentUrl = joinBasePath(this.baseUrl, relativePath);
    let redirects = 0;

    for (;;) {
      const target = await withDeadline(
        validateAndPinHttpsTarget(currentUrl, this.resolver),
        deadline,
      ).catch((error: unknown) => {
        if (error instanceof WooCommerceClientError) {
          throw error;
        }
        if (error instanceof WooCommerceSsrfError) {
          throw new WooCommerceClientError(error.code);
        }
        throw new WooCommerceClientError('dns_failed');
      });
      let response: WooCommerceHttpResponse;
      try {
        response = await withDeadline(
          this.transport(
            target,
            { Authorization: this.authorization, Accept: 'application/json' },
            deadline,
          ),
          deadline,
        );
      } catch (error) {
        if (error instanceof WooCommerceClientError) {
          throw error;
        }
        throw new WooCommerceClientError('upstream_error');
      }
      if (Buffer.byteLength(response.body, 'utf8') > this.maxResponseBytes) {
        throw new WooCommerceClientError('response_too_large', response.status);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = headerValue(response.headers, 'location');
        if (!location) {
          throw new WooCommerceClientError('redirect_rejected', response.status);
        }
        if (redirects >= this.maxRedirects) {
          throw new WooCommerceClientError('redirect_limit_exceeded', response.status);
        }

        let redirectedUrl: URL;
        try {
          redirectedUrl = new URL(location, target.url);
          parseWooCommerceRequestUrl(redirectedUrl.toString());
        } catch {
          throw new WooCommerceClientError('redirect_rejected', response.status);
        }

        if (redirectedUrl.origin !== target.url.origin) {
          throw new WooCommerceClientError('redirect_rejected', response.status);
        }

        currentUrl = redirectedUrl.toString();
        redirects += 1;
        continue;
      }

      let body: unknown = null;
      if (response.body && isJsonResponse(response.headers)) {
        body = parseJson(response.body);
      } else if (response.status >= 200 && response.status < 300) {
        throw new WooCommerceClientError('response_not_json', response.status);
      }

      const classification = classifyWooCommerceResponse(response.status, body);
      if (!classification.ok) {
        throw new WooCommerceClientError(classification.code, response.status);
      }
      return body;
    }
  }

  async readIdentity(expectedIdentity: string): Promise<WooCommerceIdentityProof> {
    let claimedIdentity: string;
    try {
      claimedIdentity = normalizeWooCommerceIdentity(expectedIdentity);
    } catch {
      throw new WooCommerceClientError('invalid_url');
    }

    const root = await this.readJson('wp-json/');
    if (typeof root !== 'object' || root === null) {
      throw new WooCommerceClientError('identity_missing');
    }

    const homeUrl = 'home' in root && typeof root.home === 'string' ? root.home : null;
    const restUrl = 'url' in root && typeof root.url === 'string' ? root.url : null;
    if (!homeUrl || !restUrl) {
      throw new WooCommerceClientError('identity_missing');
    }

    let canonicalIdentity: string;
    try {
      canonicalIdentity = normalizeWooCommerceIdentity(homeUrl);
    } catch {
      throw new WooCommerceClientError('identity_missing');
    }

    if (canonicalIdentity !== claimedIdentity) {
      throw new WooCommerceClientError('identity_mismatch');
    }

    return { claimedIdentity, canonicalIdentity, restUrl, homeUrl };
  }

  async readApiRoot(): Promise<unknown> {
    return this.readJson('wp-json/wc/v3');
  }
}
