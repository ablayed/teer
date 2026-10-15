import {
  DIAGNOSTIC_HEADERS,
  type KongProbeRecord,
  createKongProbe,
  normalizeRoute,
  redactText,
} from '@/tests/helpers/kong-probe';
import { describe, expect, it } from 'vitest';

const TARGET = 'http://127.0.0.1:54321';
const UPSTREAM = 'An invalid response was received from the upstream server';

function setup(handler: (url: string) => Response | Promise<Response>) {
  const records: KongProbeRecord[] = [];
  const probe = createKongProbe(
    ((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(handler(url));
    }) as typeof fetch,
    {
      target: TARGET,
      sink: (record) => records.push(record),
      pid: 4242,
      worker: '3',
    },
  );
  return { probe, records };
}

describe('sonde de la passerelle : routes et texte expurgés', () => {
  it('remplace les identifiants et retire les valeurs de requête', () => {
    expect(
      normalizeRoute(
        `${TARGET}/rest/v1/orders?id=eq.8f14e45f-ceea-467a-9575-d7bd2c4d6e3a&select=id,total&email=eq.a@b.co`,
      ),
    ).toBe('/rest/v1/orders?id&select&email');
    expect(normalizeRoute(`${TARGET}/rest/v1/rpc/f/8f14e45f-ceea-467a-9575-d7bd2c4d6e3a`)).toBe(
      '/rest/v1/rpc/f/:id',
    );
    expect(normalizeRoute(`${TARGET}/auth/v1/admin/users/12345678901`)).toBe(
      '/auth/v1/admin/users/:n',
    );
  });

  it('expurge jetons, courriels et identifiants, et tronque', () => {
    const text = `x eyJhbGciOi.eyJzdWIi.c2ln a@b.co 8f14e45f-ceea-467a-9575-d7bd2c4d6e3a ${'y'.repeat(300)}`;
    const out = redactText(text);
    expect(out).toContain('[jeton]');
    expect(out).toContain('[courriel]');
    expect(out).toContain(':id');
    expect(out).not.toMatch(/eyJ|a@b\.co|8f14e45f/);
    expect(out.length).toBeLessThanOrEqual(160);
  });
});

describe('sonde de la passerelle : observation', () => {
  it('une réponse en 5xx est consignée avec statut, route, en-têtes de la liste blanche, corps expurgé', async () => {
    const { probe, records } = setup(
      () =>
        new Response(UPSTREAM, {
          status: 502,
          statusText: 'Bad Gateway',
          headers: {
            server: 'kong/2.8',
            'x-kong-upstream-latency': '12',
            authorization: 'Bearer secret',
            'set-cookie': 'a=b',
          },
        }),
    );
    const response = await probe.fetch(`${TARGET}/rest/v1/rpc/set_order_note?x=1`, {
      method: 'POST',
      body: '{"secret":"valeur"}',
    });

    expect(response.status).toBe(502);
    // La réponse rendue à l'appelant est intacte : son corps reste lisible.
    expect(await response.text()).toBe(UPSTREAM);
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record).toMatchObject({
      kind: 'reponse_5xx',
      status: 502,
      invalidUpstream: true,
      method: 'POST',
      route: '/rest/v1/rpc/set_order_note?x',
      pid: 4242,
      worker: '3',
    });
    expect(Object.keys(record.headers).sort()).toEqual([
      'content-type',
      'server',
      'x-kong-upstream-latency',
    ]);
    for (const name of Object.keys(record.headers)) {
      expect(DIAGNOSTIC_HEADERS as readonly string[]).toContain(name);
    }
    expect(JSON.stringify(record)).not.toMatch(/secret|valeur|Bearer|set-cookie/i);
  });

  it('une réponse en succès ne produit aucune ligne, mais est comptée', async () => {
    const { probe, records } = setup(() => new Response('ok', { status: 200 }));
    await probe.fetch(`${TARGET}/rest/v1/orders`);
    expect(records).toHaveLength(0);
    expect(probe.counters.total).toBe(1);
    expect(probe.counters.byStatusClass['2xx']).toBe(1);
  });

  it('un appel hors de la cible n’est ni observé ni compté', async () => {
    const { probe, records } = setup(() => new Response(UPSTREAM, { status: 502 }));
    await probe.fetch('https://example.com/x');
    expect(records).toHaveLength(0);
    expect(probe.counters.total).toBe(0);
  });

  it('retient la classe de la réponse précédente du même processus', async () => {
    const statuses = [400, 502];
    const { probe, records } = setup(
      () => new Response(UPSTREAM, { status: statuses.shift() ?? 200 }),
    );
    await probe.fetch(`${TARGET}/rest/v1/rpc/a`);
    await probe.fetch(`${TARGET}/rest/v1/rpc/b`);
    expect(records).toHaveLength(1);
    expect(records[0].previousStatusClass).toBe('4xx');
  });

  it('mesure la concurrence dans le processus au moment de l’appel', async () => {
    const releases: Array<() => void> = [];
    const records: KongProbeRecord[] = [];
    const probe = createKongProbe(
      (() =>
        new Promise<Response>((resolve) => {
          releases.push(() => resolve(new Response(UPSTREAM, { status: 502 })));
        })) as unknown as typeof fetch,
      { target: TARGET, sink: (record) => records.push(record) },
    );
    const calls = [
      probe.fetch(`${TARGET}/rest/v1/a`),
      probe.fetch(`${TARGET}/rest/v1/b`),
      probe.fetch(`${TARGET}/rest/v1/c`),
    ];
    for (const release of releases) release();
    await Promise.all(calls);
    expect(probe.counters.maxInflight).toBe(3);
    expect(records.map((r) => r.inflightInProcess).sort()).toEqual([1, 2, 3]);
  });

  it('la concurrence retombe à 1 entre deux appels successifs', async () => {
    const { probe, records } = setup(() => new Response(UPSTREAM, { status: 502 }));
    await probe.fetch(`${TARGET}/rest/v1/a`);
    await probe.fetch(`${TARGET}/rest/v1/b`);
    expect(records.map((r) => r.inflightInProcess)).toEqual([1, 1]);
  });

  it('une erreur réseau est consignée (nom et code seulement) puis relancée', async () => {
    const records: KongProbeRecord[] = [];
    const failure = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const probe = createKongProbe((() => Promise.reject(failure)) as unknown as typeof fetch, {
      target: TARGET,
      sink: (record) => records.push(record),
    });
    await expect(probe.fetch(`${TARGET}/rest/v1/a`)).rejects.toBe(failure);
    expect(records[0]).toMatchObject({
      kind: 'erreur_reseau',
      errorName: 'TypeError',
      errorCode: 'ECONNRESET',
      status: null,
    });
    expect(probe.counters.byStatusClass.reseau).toBe(1);
  });
});
