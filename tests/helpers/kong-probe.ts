/**
 * Sonde de la passerelle (kong) pour la suite RLS — diagnostic de l'instabilité « An invalid response
 * was received from the upstream server ».
 *
 * N'altère aucun appel : chaque `fetch` vers la cible Supabase est observé, jamais rejoué ni modifié.
 * Quand une réponse est en 5xx (ou qu'un appel échoue au niveau réseau), une ligne technique est
 * consignée : statut brut, en-têtes de diagnostic d'une liste blanche, route normalisée (identifiants
 * remplacés, valeurs de requête retirées), concurrence DANS le processus au moment de l'appel,
 * statut de la réponse précédente du même processus.
 *
 * Sans donnée sensible : ni corps de requête, ni en-têtes d'autorisation, ni valeurs de paramètres. Le
 * corps d'une réponse en erreur n'est conservé que expurgé (jetons, courriels, identifiants) et tronqué.
 * Le but est de décider si la coupure précède ou suit la réponse de PostgREST, et de la relier à la
 * concurrence interne d'un job.
 */

import { appendFileSync } from 'node:fs';

const KONG_INVALID_UPSTREAM = 'An invalid response was received from the upstream server';

// Seuls ces en-têtes sont retenus : ils décrivent la passerelle, pas l'application.
export const DIAGNOSTIC_HEADERS = [
  'server',
  'via',
  'content-type',
  'content-length',
  'connection',
  'retry-after',
  'x-kong-response-latency',
  'x-kong-upstream-latency',
  'x-kong-proxy-latency',
  'x-request-id',
] as const;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LONG_NUMBER = /\b\d{6,}\b/g;

/** Chemin sans identifiants ni valeurs de requête : `/rest/v1/rpc/f?select=a&id=eq.X` → `/rest/v1/rpc/f?select&id`. */
export function normalizeRoute(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return '(url illisible)';
  }
  const path = url.pathname.replace(UUID, ':id').replace(LONG_NUMBER, ':n');
  const keys = [...new Set([...url.searchParams.keys()])];
  return keys.length > 0 ? `${path}?${keys.join('&')}` : path;
}

export function redactText(text: string, limit = 160): string {
  return text
    .replace(JWT, '[jeton]')
    .replace(EMAIL, '[courriel]')
    .replace(UUID, ':id')
    .replace(LONG_NUMBER, ':n')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

export type KongProbeRecord = {
  at: string;
  pid: number;
  worker: string | null;
  method: string;
  route: string;
  kind: 'reponse_5xx' | 'erreur_reseau';
  status: number | null;
  statusText: string | null;
  invalidUpstream: boolean;
  headers: Record<string, string>;
  body: string | null;
  errorName: string | null;
  errorCode: string | null;
  inflightInProcess: number;
  previousStatusClass: string | null;
  durationMs: number;
};

export type KongProbeCounters = {
  total: number;
  byStatusClass: Record<string, number>;
  maxInflight: number;
};

type ProbeOptions = {
  /** Origine de la passerelle observée (ex. `http://127.0.0.1:54321`). */
  target: string;
  sink: (record: KongProbeRecord) => void;
  now?: () => number;
  pid?: number;
  worker?: string | null;
};

const statusClass = (status: number) => `${Math.floor(status / 100)}xx`;

/**
 * Enveloppe un `fetch`. Le résultat est strictement celui de l'original (la réponse rendue à
 * l'appelant n'est jamais consommée : le corps n'est lu que sur un clone).
 */
export function createKongProbe(original: typeof fetch, options: ProbeOptions) {
  const now = options.now ?? Date.now;
  const counters: KongProbeCounters = { total: 0, byStatusClass: {}, maxInflight: 0 };
  let inflight = 0;
  let previous: string | null = null;
  const targetOrigin = new URL(options.target).origin;

  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    let observed = false;
    try {
      observed = new URL(rawUrl).origin === targetOrigin;
    } catch {
      observed = false;
    }
    if (!observed) return original(input, init);

    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const route = normalizeRoute(rawUrl);
    const startedAt = now();
    inflight += 1;
    counters.total += 1;
    counters.maxInflight = Math.max(counters.maxInflight, inflight);
    const inflightAtCall = inflight;
    const base = {
      pid: options.pid ?? process.pid,
      worker: options.worker ?? process.env.VITEST_POOL_ID ?? null,
      method,
      route,
      inflightInProcess: inflightAtCall,
      previousStatusClass: previous,
    };
    try {
      const response = await original(input, init);
      const cls = statusClass(response.status);
      counters.byStatusClass[cls] = (counters.byStatusClass[cls] ?? 0) + 1;
      const previousBefore = previous;
      previous = cls;
      if (response.status >= 500) {
        let body: string | null = null;
        try {
          body = redactText(await response.clone().text());
        } catch {
          body = null;
        }
        const headers: Record<string, string> = {};
        for (const name of DIAGNOSTIC_HEADERS) {
          const value = response.headers.get(name);
          if (value !== null) headers[name] = redactText(value, 120);
        }
        options.sink({
          at: new Date(now()).toISOString(),
          ...base,
          previousStatusClass: previousBefore,
          kind: 'reponse_5xx',
          status: response.status,
          statusText: response.statusText || null,
          invalidUpstream: (body ?? '').includes(KONG_INVALID_UPSTREAM),
          headers,
          body,
          errorName: null,
          errorCode: null,
          durationMs: now() - startedAt,
        });
      }
      return response;
    } catch (error) {
      counters.byStatusClass.reseau = (counters.byStatusClass.reseau ?? 0) + 1;
      previous = 'reseau';
      const cause = (error as { cause?: { code?: string } } | null)?.cause;
      options.sink({
        at: new Date(now()).toISOString(),
        ...base,
        kind: 'erreur_reseau',
        status: null,
        statusText: null,
        invalidUpstream: false,
        headers: {},
        body: null,
        errorName: (error as { name?: string } | null)?.name ?? null,
        errorCode: cause?.code ?? (error as { code?: string } | null)?.code ?? null,
        durationMs: now() - startedAt,
      });
      throw error;
    } finally {
      inflight -= 1;
    }
  };

  return { fetch: wrapped as typeof fetch, counters };
}

function writeLine(env: NodeJS.ProcessEnv, payload: unknown, echo: boolean) {
  const line = `${JSON.stringify(payload)}
`;
  const file = env.KONG_PROBE_FILE;
  if (file) {
    try {
      appendFileSync(file, line);
    } catch {
      // Une sonde ne casse jamais un test.
    }
  }
  if (echo) process.stderr.write(`[kong-probe] ${line}`);
}

// Le fichier garde tout ; la sortie des tests ne reçoit que ce qui ressemble à une coupure de passerelle
// (les 500 applicatifs attendus, comme P0002, noieraient le journal).
function looksLikeGatewayCut(record: KongProbeRecord) {
  return (
    record.invalidUpstream ||
    record.kind === 'erreur_reseau' ||
    [502, 503, 504].includes(record.status ?? 0)
  );
}

/** Installe la sonde sur `globalThis.fetch` quand `CI_KONG_PROBE=1` ; consigne en JSON lignes. */
export function installKongProbeFromEnv(env: NodeJS.ProcessEnv = process.env) {
  if (env.CI_KONG_PROBE !== '1') return null;
  const target = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
  if (!target) return null;
  const probe = createKongProbe(globalThis.fetch.bind(globalThis), {
    target,
    sink: (record) => writeLine(env, record, looksLikeGatewayCut(record)),
  });
  globalThis.fetch = probe.fetch;
  return {
    ...probe,
    // Dénominateurs : sans eux, un nombre d'échecs ne dit rien d'un taux.
    summarize: (testPath: string | undefined) =>
      writeLine(
        env,
        { kind: 'resume_fichier', testPath: testPath ?? null, ...probe.counters },
        false,
      ),
  };
}
