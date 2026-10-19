// V11 — instrumentation TEMPORAIRE des appels sortants vers Supabase (runtime nodejs).
//
// Objet : départager trois hypothèses sur la lenteur variable des appels Supabase en production
// (plan vitesse v2). H1 : le fetch de Node n'a pas de connexion à réutiliser (undici ferme une
// socket inactive après ~4 s). H2 : l'attente vient d'en amont (passerelle, Auth, compute). H3 :
// l'instance Vercel est fraîche ou sa boucle d'événements est occupée.
//
// Module PUR : il n'importe ni `lib/env`, ni un client Supabase, ni `node:*`. Tout ce qui touche
// l'environnement (canaux de diagnostic, horloge, sortie) est INJECTÉ, ce qui le rend testable
// sans réseau. L'installation réelle est dans `supabase-call-trace-runtime.ts`.
//
// CONFIDENTIALITÉ — ce qui n'est JAMAIS lu ni écrit : URL complète, chaîne de requête, fragment,
// en-tête (requête ou réponse), cookie, jeton, corps, identifiant de ligne. Le chemin n'est lu que
// pour en tirer un NOM D'OPÉRATION à liste blanche (`rpc:<fonction>`, `table:<table>`,
// `auth:<verbe>`) ; tout autre chemin devient `other`. Seuls les appels dont l'origine est l'hôte
// Supabase configuré sont enregistrés. Aucune erreur n'est journalisée au-delà de son code.

export type TraceHandler = (message: unknown) => void;

export type CallTraceDeps = {
  subscribe: (channel: string, handler: TraceHandler) => void;
  /** Horloge monotone en millisecondes ; depuis le démarrage du processus (performance.now). */
  now: () => number;
  /** Une ligne JSON par événement (console.log en production). */
  emit: (line: string) => void;
  /** Hôte Supabase (`xxxx.supabase.co`) : les appels vers toute autre origine sont ignorés. */
  supabaseHost: string;
  /** Identifiant aléatoire du processus : regroupe les lignes d'une même instance. */
  bootId: string;
  /** Faits de démarrage (version de Node, d'undici, région). Aucune valeur secrète. */
  boot: Record<string, string | number | null>;
  /** Retard de la boucle d'événements sur la dernière fenêtre close, en ms. */
  loopLag: () => { p99: number; max: number } | null;
  /** Plafond de lignes par processus : au-delà, une seule ligne l'annonce puis plus rien. */
  maxLines?: number;
};

const DEFAULT_MAX_LINES = 20_000;

const CHANNELS = {
  create: 'undici:request:create',
  beforeConnect: 'undici:client:beforeConnect',
  connected: 'undici:client:connected',
  connectError: 'undici:client:connectError',
  sendHeaders: 'undici:client:sendHeaders',
  headers: 'undici:request:headers',
  trailers: 'undici:request:trailers',
  error: 'undici:request:error',
} as const;

const NAME = /^[a-z0-9_]{1,63}$/;
const AUTH_VERBS = new Set([
  'user',
  'token',
  'logout',
  'signup',
  'recover',
  'verify',
  'otp',
  'sso',
  'admin',
]);
const METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE', 'HEAD', 'PUT', 'OPTIONS']);

/** Nom d'opération à liste blanche, tiré du SEUL chemin (sans requête ni fragment). */
export function classifySupabaseOperation(rawPath: string): string {
  const path = (rawPath.split('?')[0] ?? '').split('#')[0] ?? '';
  const segments = path.split('/').filter(Boolean);
  const [area, version, kind, name] = segments;

  if (area === 'auth' && version === 'v1') {
    return kind && AUTH_VERBS.has(kind) ? `auth:${kind}` : 'auth:other';
  }
  if (area === 'rest' && version === 'v1') {
    if (kind === 'rpc') return name && NAME.test(name) ? `rpc:${name}` : 'rpc:other';
    return kind && NAME.test(kind) ? `table:${kind}` : 'rest:other';
  }
  return 'other';
}

type RequestLike = { origin?: unknown; path?: unknown; method?: unknown };
type SocketLike = { alpnProtocol?: unknown };

type SocketInfo = { id: number; bornAt: number; connectMs: number | null; uses: number };

type CallState = {
  op: string;
  method: string;
  tCreate: number;
  tSend?: number;
  tHeaders?: number;
  status?: number;
  socketId?: number;
  socketNew?: boolean;
  socketAgeMs?: number;
  socketUses?: number;
  connectMs?: number | null;
  alpn?: string;
};

const round = (value: number): number => Math.round(value * 10) / 10;

function originHost(origin: unknown): string | null {
  if (typeof origin !== 'string') return null;
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/** `Hôte:443` et `hôte` désignent la même origine HTTPS : on compare sans port par défaut. */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/:443$/, '');
}

/** Hôte visé par un événement de connexion, tiré de `connectParams.host` seulement. */
function connectHost(message: unknown): string | null {
  if (!isObject(message) || !isObject(message.connectParams)) return null;
  const host = message.connectParams.host;
  return typeof host === 'string' && host !== '' ? normalizeHost(host) : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function installSupabaseCallTrace(deps: CallTraceDeps): void {
  const maxLines = deps.maxLines ?? DEFAULT_MAX_LINES;
  const calls = new WeakMap<object, CallState>();
  const sockets = new WeakMap<object, SocketInfo>();
  // Départs de connexion vers l'hôte Supabase, en attente de leur `connected`/`connectError`.
  // undici ne passe PAS le même objet `connectParams` aux deux événements : l'appariement se
  // fait par hôte (file), exact tant qu'une seule connexion vers cet hôte est en vol à la fois.
  const supabaseHost = normalizeHost(deps.supabaseHost);
  const connectQueue: number[] = [];
  let socketCounter = 0;
  let sequence = 0;
  let lines = 0;
  let exhausted = false;

  const emit = (record: Record<string, unknown>): void => {
    if (exhausted) return;
    if (lines >= maxLines) {
      exhausted = true;
      deps.emit(JSON.stringify({ tag: 'v11', ev: 'budget', boot: deps.bootId, lines }));
      return;
    }
    lines += 1;
    deps.emit(JSON.stringify({ tag: 'v11', boot: deps.bootId, ...record }));
  };

  // Un abonné qui lève ferait remonter l'exception au processus : jamais.
  const safe =
    (handler: TraceHandler): TraceHandler =>
    (message) => {
      try {
        handler(message);
      } catch {
        // L'instrumentation ne doit jamais perturber une requête.
      }
    };

  const socketInfo = (socket: unknown): SocketInfo | null => {
    if (!isObject(socket)) return null;
    let info = sockets.get(socket);
    if (!info) {
      // Socket vue pour la première fois sans `connected` (ouverte avant l'installation).
      socketCounter += 1;
      info = { id: socketCounter, bornAt: deps.now(), connectMs: null, uses: 0 };
      sockets.set(socket, info);
    }
    return info;
  };

  const finish = (state: CallState, error: string | null): void => {
    const end = deps.now();
    sequence += 1;
    const lag = deps.loopLag();
    const tSend = state.tSend ?? null;
    const tHeaders = state.tHeaders ?? null;
    emit({
      ev: 'call',
      seq: sequence,
      proc_age_s: Math.round(end / 1000),
      op: state.op,
      method: state.method,
      status: state.status ?? null,
      sock: state.socketId ?? null,
      sock_new: state.socketNew ?? null,
      sock_age_ms: state.socketAgeMs === undefined ? null : round(state.socketAgeMs),
      sock_uses: state.socketUses ?? null,
      connect_ms: state.connectMs == null ? null : round(state.connectMs),
      alpn: state.alpn ?? null,
      wait_ms: tSend === null ? null : round(tSend - state.tCreate),
      ttfb_ms: tSend === null || tHeaders === null ? null : round(tHeaders - tSend),
      body_ms: tHeaders === null ? null : round(end - tHeaders),
      total_ms: round(end - state.tCreate),
      loop_p99_ms: lag ? round(lag.p99) : null,
      loop_max_ms: lag ? round(lag.max) : null,
      err: error,
    });
  };

  deps.subscribe(
    CHANNELS.create,
    safe((message) => {
      if (!isObject(message) || !isObject(message.request)) return;
      const request = message.request as RequestLike;
      if (originHost(request.origin) !== deps.supabaseHost) return;
      const method = typeof request.method === 'string' ? request.method.toUpperCase() : '';
      calls.set(message.request, {
        op: classifySupabaseOperation(typeof request.path === 'string' ? request.path : ''),
        method: METHODS.has(method) ? method : 'OTHER',
        tCreate: deps.now(),
      });
    }),
  );

  // Seule la connexion vers l'hôte Supabase est suivie : une ouverture parallèle vers un autre
  // hôte (Upstash, Sentry) ne consomme jamais la file et ne fausse donc aucune mesure.
  deps.subscribe(
    CHANNELS.beforeConnect,
    safe((message) => {
      if (connectHost(message) !== supabaseHost) return;
      connectQueue.push(deps.now());
      // Garde-fou : une file qui ne se vide jamais ne doit pas croître sans borne.
      if (connectQueue.length > 64) connectQueue.shift();
    }),
  );

  deps.subscribe(
    CHANNELS.connectError,
    safe((message) => {
      if (connectHost(message) !== supabaseHost) return;
      // Une tentative qui échoue sort de la file : sans cela, la connexion réussie suivante
      // hériterait de son horodatage de départ.
      const started = connectQueue.shift();
      const error = isObject(message) && isObject(message.error) ? message.error : null;
      const code = error && typeof error.code === 'string' ? error.code.slice(0, 40) : 'unknown';
      emit({
        ev: 'connect_error',
        proc_age_s: Math.round(deps.now() / 1000),
        connect_ms: started === undefined ? null : round(deps.now() - started),
        err: code,
      });
    }),
  );

  deps.subscribe(
    CHANNELS.connected,
    safe((message) => {
      if (!isObject(message) || !isObject(message.socket)) return;
      if (connectHost(message) !== supabaseHost) return;
      const started = connectQueue.shift();
      socketCounter += 1;
      sockets.set(message.socket, {
        id: socketCounter,
        bornAt: deps.now(),
        connectMs: started === undefined ? null : deps.now() - started,
        uses: 0,
      });
    }),
  );

  deps.subscribe(
    CHANNELS.sendHeaders,
    safe((message) => {
      if (!isObject(message) || !isObject(message.request)) return;
      const state = calls.get(message.request);
      if (!state) return;
      const info = socketInfo(message.socket);
      state.tSend = deps.now();
      if (info) {
        state.socketId = info.id;
        state.socketNew = info.uses === 0;
        state.socketAgeMs = state.tSend - info.bornAt;
        state.socketUses = info.uses;
        state.connectMs = info.uses === 0 ? info.connectMs : null;
        info.uses += 1;
      }
      const alpn = (message.socket as SocketLike).alpnProtocol;
      state.alpn = typeof alpn === 'string' && alpn !== '' ? alpn : 'none';
    }),
  );

  deps.subscribe(
    CHANNELS.headers,
    safe((message) => {
      if (!isObject(message) || !isObject(message.request)) return;
      const state = calls.get(message.request);
      if (!state) return;
      state.tHeaders = deps.now();
      const response = message.response;
      if (isObject(response) && typeof response.statusCode === 'number') {
        state.status = response.statusCode;
      }
    }),
  );

  deps.subscribe(
    CHANNELS.trailers,
    safe((message) => {
      if (!isObject(message) || !isObject(message.request)) return;
      const state = calls.get(message.request);
      if (!state) return;
      calls.delete(message.request);
      finish(state, null);
    }),
  );

  deps.subscribe(
    CHANNELS.error,
    safe((message) => {
      if (!isObject(message) || !isObject(message.request)) return;
      const state = calls.get(message.request);
      if (!state) return;
      calls.delete(message.request);
      // Le CODE seulement (`UND_ERR_SOCKET`, `ECONNRESET`) : jamais le message ni la pile.
      const error = isObject(message.error) ? message.error : null;
      const code = error && typeof error.code === 'string' ? error.code.slice(0, 40) : 'unknown';
      finish(state, code);
    }),
  );

  emit({ ...deps.boot, ev: 'boot' });
}
