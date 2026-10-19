import { subscribe } from 'node:diagnostics_channel';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { installSupabaseCallTrace } from '@/lib/monitoring/supabase-call-trace';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Les tests à bus factice encodent des hypothèses sur la forme des événements d'undici. Celui-ci
// les confronte au VRAI `fetch` de Node, contre un serveur local, avec le vrai `diagnostics_channel`.
const lines: Array<Record<string, unknown>> = [];
const raw: string[] = [];
let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;

  installSupabaseCallTrace({
    subscribe: (channel, handler) => subscribe(channel, handler),
    now: () => performance.now(),
    emit: (line) => {
      raw.push(line);
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
    supabaseHost: `127.0.0.1:${port}`,
    bootId: 'boot-reel',
    boot: { node: process.version },
    loopLag: () => null,
  });
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe('V11 — contre le vrai fetch de Node (undici)', () => {
  it('mesure chaque appel, distingue socket neuve et réutilisée, et ne lit aucune requête', async () => {
    const secret = 'telephone-synthetique-221770000000';
    const paths = [
      `/rest/v1/orders?select=*&phone=eq.${secret}`,
      '/rest/v1/rpc/list_my_stores',
      '/auth/v1/user',
      `/rest/v1/order_line?id=eq.${secret}`,
      '/rest/v1/orders',
      '/rest/v1/rpc/get_order_view_counts',
    ];
    for (const path of paths) {
      const response = await fetch(`${base}${path}`, {
        headers: { authorization: `Bearer ${secret}`, apikey: secret },
      });
      await response.text();
    }

    const calls = lines.filter((line) => line.ev === 'call');
    expect(calls).toHaveLength(paths.length);
    expect(calls.map((call) => call.op)).toEqual([
      'table:orders',
      'rpc:list_my_stores',
      'auth:user',
      'table:order_line',
      'table:orders',
      'rpc:get_order_view_counts',
    ]);
    for (const call of calls) {
      expect(call.status).toBe(200);
      expect(typeof call.sock).toBe('number');
      expect(typeof call.sock_new).toBe('boolean');
      expect(call.wait_ms as number).toBeGreaterThanOrEqual(0);
      expect(call.ttfb_ms as number).toBeGreaterThanOrEqual(0);
      expect(call.total_ms as number).toBeGreaterThanOrEqual(call.ttfb_ms as number);
      expect(call.err).toBeNull();
    }
    // La première socket est neuve et porte un coût de connexion ; au moins une est réutilisée.
    expect(calls[0]).toMatchObject({ sock_new: true });
    expect(typeof calls[0]?.connect_ms).toBe('number');
    expect(calls.some((call) => call.sock_new === false)).toBe(true);
    // Une socket réutilisée n'a plus de coût de connexion.
    for (const call of calls.filter((c) => c.sock_new === false)) {
      expect(call.connect_ms).toBeNull();
      expect(call.sock_uses as number).toBeGreaterThan(0);
    }

    const output = raw.join('\n');
    expect(output).not.toContain(secret);
    expect(output).not.toContain('Bearer');
    expect(output).not.toContain('select=');
    expect(output).not.toContain('127.0.0.1');
  });
});

describe('V11 — connexion refusée, contre le vrai fetch de Node (undici)', () => {
  it('journalise connect_error avec le seul code, puis l’appel en erreur', async () => {
    // Port obtenu puis libéré : plus rien n'y écoute, la connexion est refusée.
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const refusedLines: Array<Record<string, unknown>> = [];
    const refusedRaw: string[] = [];
    installSupabaseCallTrace({
      subscribe: (channel, handler) => subscribe(channel, handler),
      now: () => performance.now(),
      emit: (line) => {
        refusedRaw.push(line);
        refusedLines.push(JSON.parse(line) as Record<string, unknown>);
      },
      supabaseHost: `127.0.0.1:${port}`,
      bootId: 'boot-refuse',
      boot: { node: process.version },
      loopLag: () => null,
    });

    await expect(fetch(`http://127.0.0.1:${port}/auth/v1/user`)).rejects.toThrow();

    const failure = refusedLines.find((line) => line.ev === 'connect_error');
    expect(failure).toMatchObject({ err: 'ECONNREFUSED' });
    expect(typeof failure?.connect_ms).toBe('number');
    expect(refusedLines.find((line) => line.ev === 'call')).toMatchObject({
      op: 'auth:user',
      err: 'ECONNREFUSED',
    });
    expect(refusedRaw.join('\n')).not.toContain('127.0.0.1');
  });
});
