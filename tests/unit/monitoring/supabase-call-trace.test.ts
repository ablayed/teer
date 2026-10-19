import {
  type CallTraceDeps,
  type TraceHandler,
  classifySupabaseOperation,
  installSupabaseCallTrace,
} from '@/lib/monitoring/supabase-call-trace';
import { describe, expect, it } from 'vitest';

const HOST = 'projet-synthetique.supabase.co';
const ORIGIN = `https://${HOST}`;

type Line = Record<string, unknown>;

function setup(overrides: Partial<CallTraceDeps> = {}) {
  const handlers = new Map<string, TraceHandler[]>();
  const lines: Line[] = [];
  const raw: string[] = [];
  let clock = 0;
  installSupabaseCallTrace({
    subscribe: (channel, handler) => {
      handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
    },
    now: () => clock,
    emit: (line) => {
      raw.push(line);
      lines.push(JSON.parse(line) as Line);
    },
    supabaseHost: HOST,
    bootId: 'boot-test',
    boot: { node: 'v24.0.0', undici: '7.0.0', region: 'fra1' },
    loopLag: () => ({ p99: 10.04, max: 12.34 }),
    ...overrides,
  });
  return {
    lines,
    raw,
    at: (ms: number) => {
      clock = ms;
    },
    publish: (channel: string, message: unknown) => {
      for (const handler of handlers.get(`undici:${channel}`) ?? []) handler(message);
    },
  };
}

const request = (path: string, method = 'GET', origin = ORIGIN) => ({ origin, path, method });
const tlsSocket = (alpn: unknown = 'http/1.1') => ({ alpnProtocol: alpn });

/** Déroule un appel complet ; `connect` simule l'ouverture d'une socket pour cet appel. */
function runCall(
  h: ReturnType<typeof setup>,
  req: object,
  socket: object,
  t0: number,
  opts: { connect?: boolean; status?: number } = {},
) {
  h.at(t0);
  h.publish('request:create', { request: req });
  let t = t0;
  if (opts.connect) {
    t += 1;
    h.at(t);
    h.publish('client:beforeConnect', { connectParams: {} });
    t += 30;
    h.at(t);
    h.publish('client:connected', { socket });
  }
  t += 2;
  h.at(t);
  h.publish('client:sendHeaders', { request: req, socket, headers: 'ne-pas-lire' });
  t += 47;
  h.at(t);
  h.publish('request:headers', { request: req, response: { statusCode: opts.status ?? 200 } });
  t += 10;
  h.at(t);
  h.publish('request:trailers', { request: req, trailers: [] });
}

describe('V11 — nom d’opération à liste blanche', () => {
  it.each([
    ['/rest/v1/rpc/list_my_stores', 'rpc:list_my_stores'],
    ['/rest/v1/rpc/list_my_stores?x=1&token=secret', 'rpc:list_my_stores'],
    ['/rest/v1/orders?select=*&phone=eq.%2B221771234567', 'table:orders'],
    ['/rest/v1/order_line', 'table:order_line'],
    ['/auth/v1/user', 'auth:user'],
    ['/auth/v1/token?grant_type=refresh_token', 'auth:token'],
    ['/auth/v1/admin/users/0b1c2d3e-0000-4000-8000-000000000000', 'auth:admin'],
    ['/auth/v1/une-route-inconnue', 'auth:other'],
    ['/rest/v1/rpc/Nom Avec Espace', 'rpc:other'],
    ['/rest/v1/rpc/', 'rpc:other'],
    ['/rest/v1/', 'rest:other'],
    ['/storage/v1/object/public/factures/une-piece-0001.pdf', 'other'],
    ['/realtime/v1/websocket?apikey=secret', 'other'],
    ['', 'other'],
  ])('%s → %s', (path, expected) => {
    expect(classifySupabaseOperation(path)).toBe(expected);
  });
});

describe('V11 — mesure par appel', () => {
  it('annonce le démarrage : version, région et identifiant du processus', () => {
    const h = setup();
    expect(h.lines).toEqual([
      {
        tag: 'v11',
        boot: 'boot-test',
        node: 'v24.0.0',
        undici: '7.0.0',
        region: 'fra1',
        ev: 'boot',
      },
    ]);
  });

  it('socket NEUVE : connexion, attente, réponse et corps séparés', () => {
    const h = setup();
    runCall(h, request('/rest/v1/rpc/list_my_stores', 'POST'), tlsSocket(), 1000, {
      connect: true,
    });
    const call = h.lines.find((l) => l.ev === 'call');
    expect(call).toMatchObject({
      op: 'rpc:list_my_stores',
      method: 'POST',
      status: 200,
      sock_new: true,
      sock_uses: 0,
      connect_ms: 30,
      alpn: 'http/1.1',
      wait_ms: 33, // 1 (avant connexion) + 30 (connexion) + 2 (mise en file)
      ttfb_ms: 47,
      body_ms: 10,
      total_ms: 90,
      seq: 1,
      loop_p99_ms: 10,
      loop_max_ms: 12.3,
      err: null,
    });
  });

  it('socket RÉUTILISÉE : plus de connexion, âge et nombre d’usages renseignés', () => {
    const h = setup();
    const socket = tlsSocket();
    runCall(h, request('/auth/v1/user'), socket, 1000, { connect: true });
    runCall(h, request('/rest/v1/orders', 'HEAD'), socket, 3000);
    const second = h.lines.filter((l) => l.ev === 'call')[1];
    expect(second).toMatchObject({
      op: 'table:orders',
      method: 'HEAD',
      sock_new: false,
      sock_uses: 1,
      connect_ms: null,
      seq: 2,
    });
    // La socket naît à `connected` (1000 + 1 + 30 = 1031) ; le second envoi part à 3000 + 2 = 3002.
    expect(second?.sock_age_ms).toBe(3002 - 1031);
    expect(second?.sock).toBe(h.lines.filter((l) => l.ev === 'call')[0]?.sock);
  });

  it('deux sockets distinctes reçoivent deux identifiants', () => {
    const h = setup();
    runCall(h, request('/auth/v1/user'), tlsSocket(), 0, { connect: true });
    runCall(h, request('/rest/v1/orders'), tlsSocket(), 500, { connect: true });
    const calls = h.lines.filter((l) => l.ev === 'call');
    expect(calls[0]?.sock).not.toBe(calls[1]?.sock);
    expect(calls.every((c) => c.sock_new === true)).toBe(true);
  });

  it('ALPN absent : « none », jamais une valeur inventée', () => {
    const h = setup();
    runCall(h, request('/auth/v1/user'), tlsSocket(false), 0, { connect: true });
    expect(h.lines.find((l) => l.ev === 'call')?.alpn).toBe('none');
  });

  it('ignore toute autre origine que l’hôte Supabase configuré', () => {
    const h = setup();
    runCall(h, request('/rest/v1/orders', 'GET', 'https://autre-service.example'), tlsSocket(), 0, {
      connect: true,
    });
    runCall(h, request('/rest/v1/orders', 'GET', 'pas-une-url'), tlsSocket(), 100, {
      connect: true,
    });
    expect(h.lines.filter((l) => l.ev === 'call')).toHaveLength(0);
  });

  it('retard de boucle absent : null, pas zéro', () => {
    const h = setup({ loopLag: () => null });
    runCall(h, request('/auth/v1/user'), tlsSocket(), 0, { connect: true });
    expect(h.lines.find((l) => l.ev === 'call')).toMatchObject({
      loop_p99_ms: null,
      loop_max_ms: null,
    });
  });
});

describe('V11 — aucune donnée sensible dans la sortie', () => {
  it('ni requête, ni en-tête, ni jeton, ni identifiant, ni message d’erreur', () => {
    const h = setup();
    const secrets = [
      '221771234567',
      'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
      'apikey-synthetique-0001',
      'session=cookie-synthetique',
      '0b1c2d3e-0000-4000-8000-000000000000',
      'select=',
    ];
    const req = request(
      `/rest/v1/customer?select=*&phone=eq.${secrets[0]}&apikey=${secrets[2]}&id=eq.${secrets[4]}`,
      'GET',
    );
    h.at(0);
    h.publish('request:create', { request: req });
    h.at(5);
    h.publish('client:sendHeaders', {
      request: req,
      socket: tlsSocket(),
      headers: `authorization: ${secrets[1]}\r\ncookie: ${secrets[3]}\r\n`,
    });
    h.at(9);
    h.publish('request:headers', {
      request: req,
      response: { statusCode: 500, headers: ['set-cookie', secrets[3]] },
    });
    h.at(12);
    h.publish('request:error', {
      request: req,
      error: Object.assign(new Error(`échec pour ${secrets[0]} ${secrets[1]}`), {
        code: 'UND_ERR_SOCKET',
      }),
    });

    const output = h.raw.join('\n');
    for (const secret of secrets) expect(output).not.toContain(secret);
    expect(output).not.toContain('https://');
    expect(output).not.toContain(HOST);
    expect(h.lines.find((l) => l.ev === 'call')).toMatchObject({
      op: 'table:customer',
      status: 500,
      err: 'UND_ERR_SOCKET',
    });
  });

  it('une erreur sans code est « unknown » : le message n’est jamais repris', () => {
    const h = setup();
    const req = request('/auth/v1/user');
    h.publish('request:create', { request: req });
    h.publish('request:error', { request: req, error: new Error('message secret') });
    expect(h.raw.join('\n')).not.toContain('message secret');
    expect(h.lines.find((l) => l.ev === 'call')?.err).toBe('unknown');
  });
});

describe('V11 — robustesse', () => {
  it('un message illisible ne lève jamais vers undici', () => {
    const h = setup();
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('lecture interdite');
        },
      },
    );
    for (const channel of [
      'request:create',
      'client:connected',
      'client:sendHeaders',
      'request:headers',
      'request:trailers',
      'request:error',
    ]) {
      expect(() => h.publish(channel, hostile)).not.toThrow();
      expect(() => h.publish(channel, null)).not.toThrow();
      expect(() => h.publish(channel, 'texte')).not.toThrow();
    }
    expect(h.lines.filter((l) => l.ev === 'call')).toHaveLength(0);
  });

  it('un appel dont la socket n’a jamais été annoncée reçoit tout de même un identifiant', () => {
    const h = setup();
    const req = request('/rest/v1/orders');
    h.at(0);
    h.publish('request:create', { request: req });
    h.at(4);
    h.publish('client:sendHeaders', { request: req, socket: tlsSocket() });
    h.at(9);
    h.publish('request:trailers', { request: req });
    expect(h.lines.find((l) => l.ev === 'call')).toMatchObject({
      sock_new: true,
      connect_ms: null,
      wait_ms: 4,
    });
  });

  it('plafond de lignes : une ligne d’annonce, puis le silence', () => {
    const h = setup({ maxLines: 3 }); // la ligne de démarrage compte
    for (let i = 0; i < 6; i += 1) {
      runCall(h, request('/auth/v1/user'), tlsSocket(), i * 100, { connect: i === 0 });
    }
    expect(h.lines.filter((l) => l.ev === 'call')).toHaveLength(2);
    expect(h.lines.filter((l) => l.ev === 'budget')).toHaveLength(1);
    expect(h.lines.length).toBe(4);
  });
});
