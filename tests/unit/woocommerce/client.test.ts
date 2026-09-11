import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import {
  WooCommerceClient,
  WooCommerceClientError,
  type WooCommerceHttpResponse,
  classifyWooCommerceResponse,
  createPinnedLookup,
  readWooCommerceBody,
} from '@/lib/woocommerce/client';
import type { PinnedHttpsTarget, ResolvedAddress } from '@/lib/woocommerce/ssrf';
import { describe, expect, it, vi } from 'vitest';

const publicAddress: ResolvedAddress = { address: '93.184.216.34', family: 4 };

function response(
  status: number,
  body: string,
  contentType = 'application/json',
): WooCommerceHttpResponse {
  return { status, body, headers: { 'content-type': contentType } };
}

function clientWith(
  responses: WooCommerceHttpResponse[],
  options: {
    readonly maxRedirects?: number;
    readonly timeoutMs?: number;
    readonly maxResponseBytes?: number;
  } = {},
) {
  const targets: PinnedHttpsTarget[] = [];
  const resolver = vi.fn(async () => [publicAddress] as const);
  const transport = vi.fn(
    async (
      target: PinnedHttpsTarget,
      _headers,
      _deadline,
      _method?: 'GET' | 'POST',
      _body?: string,
    ) => {
      targets.push(target);
      const next = responses.shift();
      if (!next) throw new Error('test transport exhausted');
      return next;
    },
  );
  return {
    client: new WooCommerceClient({
      baseUrl: 'https://Shop.Example.test/wordpress/',
      consumerKey: 'ck_private',
      consumerSecret: 'cs_private',
      resolver,
      transport,
      ...options,
    }),
    resolver,
    transport,
    targets,
  };
}

async function clientError(action: Promise<unknown>): Promise<WooCommerceClientError> {
  try {
    await action;
    throw new Error('expected rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(WooCommerceClientError);
    return error as WooCommerceClientError;
  }
}

describe('WooCommerce REST client', () => {
  it('sends Basic Auth and preserves a WordPress subdirectory', async () => {
    const setup = clientWith([response(200, '{"ok":true}')]);
    await expect(setup.client.readJson('wp-json/wc/v3')).resolves.toEqual({ ok: true });
    expect(setup.targets[0]?.url.pathname).toBe('/wordpress/wp-json/wc/v3');
    expect(setup.transport.mock.calls[0]?.[1]).toMatchObject({
      Authorization: `Basic ${Buffer.from('ck_private:cs_private').toString('base64')}`,
      Accept: 'application/json',
    });
  });

  it('expose les compteurs WordPress avec la réponse JSON de pagination', async () => {
    const setup = clientWith([
      {
        status: 200,
        body: '[]',
        headers: {
          'content-type': 'application/json',
          'x-wp-total': '12',
          'x-wp-totalpages': '1',
        },
      },
    ]);
    await expect(setup.client.readJsonWithHeaders('wp-json/wc/v3/orders?page=1')).resolves.toEqual({
      data: [],
      headers: {
        'content-type': 'application/json',
        'x-wp-total': '12',
        'x-wp-totalpages': '1',
      },
    });
  });

  it('envoie une création JSON en POST avec la credential Basic explicite', async () => {
    const setup = clientWith([response(201, '{"id":1}')]);
    await expect(
      setup.client.writeJson('wp-json/wc/v3/webhooks', {
        topic: 'order.created',
        delivery_url: 'https://app.example.test/api/woocommerce/webhooks/token',
        secret: 'hmac-secret-sentinel',
      }),
    ).resolves.toEqual({ id: 1 });
    expect(setup.transport.mock.calls[0]?.[2]).toBeDefined();
    expect(setup.transport.mock.calls[0]?.[3]).toBe('POST');
    expect(setup.transport.mock.calls[0]?.[4]).toContain('hmac-secret-sentinel');
    expect(setup.transport.mock.calls[0]?.[1]).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from('ck_private:cs_private').toString('base64')}`,
    });
  });

  it('reads the canonical identity from home with its real trailing slash', async () => {
    const setup = clientWith([
      response(
        200,
        JSON.stringify({
          home: 'HTTPS://SHOP.EXAMPLE.TEST/wordpress/',
          url: 'https://shop.example.test/wordpress/wp-json/',
        }),
      ),
    ]);
    await expect(
      setup.client.readIdentity('https://shop.example.test/wordpress'),
    ).resolves.toMatchObject({
      canonicalIdentity: 'https://shop.example.test/wordpress',
      homeUrl: 'HTTPS://SHOP.EXAMPLE.TEST/wordpress/',
    });
  });

  it('refuses a claimed identity that differs from the relayed canonical home', async () => {
    const setup = clientWith([
      response(
        200,
        JSON.stringify({
          home: 'https://other.example.test/',
          url: 'https://other.example.test/wp-json/',
        }),
      ),
    ]);
    const error = await clientError(
      setup.client.readIdentity('https://shop.example.test/wordpress'),
    );
    expect(error.code).toBe('identity_mismatch');
    expect(error.message).toBe('identity_mismatch');
    expect(error.message).not.toContain('other.example.test');
    expect(setup.transport).toHaveBeenCalledTimes(1);
  });

  it('follows same-origin redirects manually and resolves every hop', async () => {
    const setup = clientWith([
      { status: 302, body: '', headers: { location: '/wp-json/next' } },
      response(200, '{"ok":true}'),
    ]);
    await expect(setup.client.readJson('wp-json/start')).resolves.toEqual({ ok: true });
    expect(setup.resolver).toHaveBeenCalledTimes(2);
    expect(setup.targets.map((target) => target.url.pathname)).toEqual([
      '/wordpress/wp-json/start',
      '/wp-json/next',
    ]);
  });

  it('rejects a cross-origin redirect before sending Authorization to the other origin', async () => {
    const setup = clientWith([
      { status: 302, body: '', headers: { location: 'https://other.example.test/wp-json/' } },
    ]);
    const error = await clientError(setup.client.readJson('wp-json/start'));
    expect(error.code).toBe('redirect_rejected');
    expect(setup.transport).toHaveBeenCalledTimes(1);
    expect(setup.transport.mock.calls[0]?.[1].Authorization).toContain('Basic ');
    expect(error.message).not.toContain('other.example.test');
  });

  it('rejects non-HTTPS and credential-bearing redirect locations', async () => {
    for (const location of [
      'http://shop.example.test/wp-json/',
      'https://user:secret@shop.example.test/wp-json/',
    ]) {
      const setup = clientWith([{ status: 302, body: '', headers: { location } }]);
      const error = await clientError(setup.client.readJson('wp-json/start'));
      expect(error.code).toBe('redirect_rejected');
      expect(error.message).not.toContain('secret');
    }
  });

  it('revalidates redirect destinations and enforces a finite redirect limit', async () => {
    const setup = clientWith(
      [
        { status: 302, body: '', headers: { location: '/one' } },
        { status: 302, body: '', headers: { location: '/two' } },
      ],
      { maxRedirects: 1 },
    );
    const error = await clientError(setup.client.readJson('wp-json/start'));
    expect(error.code).toBe('redirect_limit_exceeded');
    expect(setup.resolver).toHaveBeenCalledTimes(2);
  });

  it.each([
    [401, 'credentials_invalid'],
    [403, 'woocommerce_access_denied'],
    [429, 'rate_limited'],
    [503, 'upstream_unavailable'],
  ] as const)('classifies HTTP %s without exposing the upstream body', async (status, code) => {
    const setup = clientWith([response(status, '<html>secret.example.test</html>', 'text/html')]);
    const error = await clientError(setup.client.readJson('wp-json/'));
    expect(error.code).toBe(code);
    expect(error.message).toBe(code);
    expect(error.message).not.toContain('secret.example.test');
  });

  it('classifies WooCommerce error codes without persisting or returning their message', () => {
    expect(
      classifyWooCommerceResponse(401, {
        code: 'woocommerce_rest_authentication_error',
        message: 'private',
      }),
    ).toEqual({ ok: false, code: 'credentials_invalid' });
    expect(
      classifyWooCommerceResponse(403, {
        code: 'woocommerce_rest_cannot_view',
        message: 'private',
      }),
    ).toEqual({ ok: false, code: 'woocommerce_access_denied' });
  });

  it('accepts only JSON success responses and valid JSON', async () => {
    const html = clientWith([response(200, '<html>not-json</html>', 'text/html')]);
    expect((await clientError(html.client.readJson('wp-json/'))).code).toBe('response_not_json');
    const invalid = clientWith([response(200, '{broken')]);
    expect((await clientError(invalid.client.readJson('wp-json/'))).code).toBe('invalid_json');
  });

  it('covers DNS, transport and body reads with one global timeout', async () => {
    const resolver = vi.fn(
      async () =>
        new Promise<readonly ResolvedAddress[]>((resolve) =>
          setTimeout(() => resolve([publicAddress]), 30),
        ),
    );
    const dnsClient = new WooCommerceClient({
      baseUrl: 'https://shop.example.test',
      consumerKey: 'ck',
      consumerSecret: 'cs',
      resolver,
      timeoutMs: 5,
    });
    expect((await clientError(dnsClient.readJson('wp-json/'))).code).toBe('timeout');

    const transportClient = new WooCommerceClient({
      baseUrl: 'https://shop.example.test',
      consumerKey: 'ck',
      consumerSecret: 'cs',
      resolver: async () => [publicAddress],
      timeoutMs: 5,
      transport: async () =>
        new Promise((resolve) => setTimeout(() => resolve(response(200, '{}')), 30)),
    });
    expect((await clientError(transportClient.readJson('wp-json/'))).code).toBe('timeout');

    const leakingTransportClient = new WooCommerceClient({
      baseUrl: 'https://shop.example.test',
      consumerKey: 'ck',
      consumerSecret: 'cs',
      resolver: async () => [publicAddress],
      transport: async () => {
        throw new Error('https://secret.example.test 127.0.0.1 cs');
      },
    });
    const sanitized = await clientError(leakingTransportClient.readJson('wp-json/'));
    expect(sanitized.code).toBe('upstream_error');
    expect(sanitized.message).toBe('upstream_error');
  });

  it('limits the decompressed body and the injected transport body', async () => {
    const source = Readable.from([
      gzipSync(Buffer.from('0123456789')),
    ]) as unknown as NodeJS.ReadableStream & { headers: Record<string, string> };
    source.headers = { 'content-encoding': 'gzip' };
    await expect(readWooCommerceBody(source as never, 5, Date.now() + 1000)).rejects.toMatchObject({
      code: 'response_too_large',
    });

    const setup = clientWith([response(200, '0123456789')], { maxResponseBytes: 5 });
    expect((await clientError(setup.client.readJson('wp-json/'))).code).toBe('response_too_large');
  });

  it('applies the same deadline while waiting for a body chunk', async () => {
    const delayed = Readable.from(
      (async function* () {
        await new Promise((resolve) => setTimeout(resolve, 30));
        yield Buffer.from('{}');
      })(),
    ) as unknown as NodeJS.ReadableStream & { headers: Record<string, string> };
    delayed.headers = {};
    await expect(readWooCommerceBody(delayed as never, 100, Date.now() + 5)).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('passes only the validated DNS address to the transport, retaining the hostname for SNI', async () => {
    const setup = clientWith([response(200, '{}')]);
    await setup.client.readJson('wp-json/');
    expect(setup.targets[0]?.address).toEqual(publicAddress);
    expect(setup.targets[0]?.hostname).toBe('shop.example.test');
  });

  it('pins the validated address even when the socket asks to resolve the hostname again', async () => {
    const target = {
      url: new URL('https://shop.example.test/wp-json/'),
      hostname: 'shop.example.test',
      port: 443,
      address: publicAddress,
    } satisfies PinnedHttpsTarget;
    const callback = vi.fn();
    createPinnedLookup(target)('rebinding.example.test', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  });
});
