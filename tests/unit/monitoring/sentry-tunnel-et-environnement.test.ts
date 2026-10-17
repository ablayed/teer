import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveSentryEnvironment } from '@/lib/monitoring/sentry-environment';
import { parseSentryDsn, tunnelTarget } from '@/lib/monitoring/sentry-tunnel';
import { afterEach, describe, expect, it, vi } from 'vitest';

const DSN = 'https://cle@o123.ingest.exemple.invalid/456';
const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

describe('environnement Sentry unique', () => {
  it('un nom explicite l’emporte, sinon l’environnement de déploiement, sinon development', () => {
    expect(resolveSentryEnvironment('perf-test', 'production')).toBe('perf-test');
    expect(resolveSentryEnvironment(undefined, 'production')).toBe('production');
    expect(resolveSentryEnvironment('', 'preview')).toBe('preview');
    expect(resolveSentryEnvironment(undefined, '')).toBe('development');
    expect(resolveSentryEnvironment(undefined, 'vercel-production')).toBe('development');
  });

  it('les trois configurations passent par le même résolveur', () => {
    for (const f of [
      'sentry.client.config.ts',
      'sentry.server.config.ts',
      'sentry.edge.config.ts',
    ]) {
      expect(lire(f)).toContain('resolveSentryEnvironment(');
    }
    expect(lire('next.config.mjs')).toContain('NEXT_PUBLIC_SENTRY_BUILD_VERCEL_ENV');
  });
});

describe('tunnel Sentry — logique', () => {
  const dsn = parseSentryDsn(DSN);
  it('seule une enveloppe de NOTRE projet est relayée, vers NOTRE hôte', () => {
    if (!dsn) throw new Error('dsn');
    const ok = `${JSON.stringify({ dsn: DSN })}\n{"type":"event"}\n{}`;
    expect(tunnelTarget(ok, dsn)).toBe('https://o123.ingest.exemple.invalid/api/456/envelope/');
    const autreProjet = `${JSON.stringify({ dsn: 'https://cle@o123.ingest.exemple.invalid/999' })}\n{}`;
    expect(tunnelTarget(autreProjet, dsn)).toBeNull();
    const autreHote = `${JSON.stringify({ dsn: 'https://cle@evil.invalid/456' })}\n{}`;
    expect(tunnelTarget(autreHote, dsn)).toBeNull();
    expect(tunnelTarget('pas du json\n{}', dsn)).toBeNull();
    expect(tunnelTarget('{}\n{}', dsn)).toBeNull();
  });

  it('la réécriture du SDK, qui transmet l’adresse du visiteur, n’est plus utilisée', () => {
    expect(lire('next.config.mjs')).not.toContain('tunnelRoute');
    expect(lire('sentry.client.config.ts')).toContain("tunnel: '/monitoring'");
  });
});

describe('tunnel Sentry — route', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function appeler(headers: Record<string, string>, body: string) {
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', DSN);
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { POST } = await import('@/app/monitoring/route');
    const response = await POST(
      new Request('https://www.exemple.test/monitoring', { method: 'POST', headers, body }),
    );
    return { response, fetchMock };
  }

  it('ne transmet à Sentry aucun en-tête de la requête entrante, en particulier l’adresse du visiteur', async () => {
    const body = `${JSON.stringify({ dsn: DSN })}\n{"type":"event"}\n{}`;
    const { response, fetchMock } = await appeler(
      {
        'x-forwarded-for': '203.0.113.9',
        'x-real-ip': '203.0.113.9',
        cookie: 'sb-projet-auth-token=CANARI-COOKIE',
        'user-agent': 'CANARI-AGENT',
        forwarded: 'for=203.0.113.9',
      },
      body,
    );
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://o123.ingest.exemple.invalid/api/456/envelope/');
    expect(init.headers).toEqual({ 'content-type': 'application/x-sentry-envelope' });
    expect(init.body).toBe(body);
  });

  it('refuse une enveloppe d’un autre projet sans rien relayer', async () => {
    const body = `${JSON.stringify({ dsn: 'https://cle@autre.invalid/1' })}\n{}`;
    const { response, fetchMock } = await appeler({}, body);
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
