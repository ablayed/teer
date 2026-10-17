import { maskDeep, sanitizeTelemetryPath } from './telemetry-sanitize';

// Transactions SERVEUR et Edge — reconstruction par liste blanche.
//
// `sanitizeSentryTransaction` ne fait que masquer le jeton L3 et transmet le reste : or une
// transaction serveur porte, hors de ce masque, la requête entière (en-têtes, cookies, chaîne de
// requête, IP déduite), le chemin brut dans son nom, et l'URL complète de chaque appel sortant
// (filtres PostgREST compris) dans les spans. L'événement est donc reconstruit à partir de zéro :
// ce qui n'est pas nommé ici n'est pas transmis. Un événement dont la route paramétrée est
// introuvable est abandonné plutôt qu'envoyé avec un chemin brut.
const SAFE_METHOD = /^[A-Z]{3,10}$/;
// Route paramétrée d'une application Next : mots, groupes `(groupe)`, `[param]`, `[...param]`,
// `[[...param]]`. Aucun caractère de requête ni de fragment.
const ROUTE_SEGMENT = String.raw`(?:[A-Za-z0-9_()-]+|\[{1,2}(?:\.{3})?[A-Za-z0-9_]+\]{1,2})`;
const SAFE_ROUTE = new RegExp(`^/(?:${ROUTE_SEGMENT}(?:/${ROUTE_SEGMENT})*)?$`);
const IDENTIFIER_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-|\d{5,}/i;
const SAFE_SPAN_DESCRIPTION = /^[A-Za-z0-9 _.\-[\]()/:]{1,120}$/;
const SAFE_LABEL = /^[A-Za-z0-9_$][A-Za-z0-9_$.:/ -]{0,79}$/;
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;

const DATA_ROUTE_KEYS = new Set([
  'http.route',
  'next.route',
  'next.page',
  'sentry.nextjs.ssr.function.route',
]);
const DATA_LABEL_KEYS = new Set([
  'sentry.op',
  'sentry.origin',
  'sentry.source',
  'next.span_type',
  'next.segment',
  'sentry.nextjs.ssr.function.type',
  'http.method',
  'http.request.method',
  'otel.kind',
]);
const DATA_NUMBER_KEYS = new Set([
  'http.response.status_code',
  'http.status_code',
  'sentry.sample_rate',
]);

type RawSpan = {
  span_id?: unknown;
  trace_id?: unknown;
  parent_span_id?: unknown;
  start_timestamp?: unknown;
  timestamp?: unknown;
  op?: unknown;
  status?: unknown;
  origin?: unknown;
  description?: unknown;
  data?: unknown;
};

function safeRoute(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length <= 200 &&
    SAFE_ROUTE.test(value) &&
    !IDENTIFIER_LIKE.test(value)
    ? value
    : undefined;
}

function safeLabel(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_LABEL.test(value) ? value : undefined;
}

function safeId(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

function pickData(data: unknown): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (!data || typeof data !== 'object') return out;
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (DATA_ROUTE_KEYS.has(key)) {
      const route = safeRoute(value);
      if (route) out[key] = route;
    } else if (DATA_LABEL_KEYS.has(key)) {
      const label = safeLabel(value);
      if (label) out[key] = label;
    } else if (DATA_NUMBER_KEYS.has(key) && typeof value === 'number') {
      out[key] = value;
    }
  }
  return out;
}

// Un appel sortant garde sa méthode et un chemin généralisé (segments en minuscules conservés,
// le reste devient `:id`) : ni hôte, ni requête, ni fragment.
function outboundDescription(description: string): string | undefined {
  const match = /^([A-Z]{3,10}) (\S+)$/.exec(description);
  if (!match) return undefined;
  const path = sanitizeTelemetryPath(match[2].replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, ''));
  return `${match[1]} ${path ?? '/:id'}`;
}

function safeSpanDescription(op: string | undefined, description: unknown): string | undefined {
  if (typeof description !== 'string') return undefined;
  if (op === 'http.client') return outboundDescription(description);
  return SAFE_SPAN_DESCRIPTION.test(description) && !IDENTIFIER_LIKE.test(description)
    ? description
    : undefined;
}

function sanitizeSpan(span: RawSpan) {
  const op = safeLabel(span.op);
  return {
    span_id: safeId(span.span_id, SPAN_ID),
    trace_id: safeId(span.trace_id, TRACE_ID),
    parent_span_id: safeId(span.parent_span_id, SPAN_ID),
    start_timestamp: typeof span.start_timestamp === 'number' ? span.start_timestamp : undefined,
    timestamp: typeof span.timestamp === 'number' ? span.timestamp : undefined,
    op,
    status: safeLabel(span.status),
    origin: safeLabel(span.origin),
    description: safeSpanDescription(op, span.description) ?? op ?? 'span',
    data: pickData(span.data),
  };
}

type RawTransaction = Record<string, unknown> & {
  transaction?: unknown;
  contexts?: { trace?: Record<string, unknown> };
  request?: { method?: unknown };
  transaction_info?: { source?: unknown };
  spans?: RawSpan[];
};

export function sanitizeSentryServerTransaction<T extends object>(event: T): T | null {
  const source = event as RawTransaction;
  const trace = source.contexts?.trace ?? {};
  const traceData = pickData(trace.data);

  const named = typeof source.transaction === 'string' ? source.transaction : '';
  const namedMatch = /^([A-Z]{3,10}) (\/\S*)$/.exec(named);
  const route =
    safeRoute(traceData['http.route']) ??
    safeRoute(traceData['next.route']) ??
    (namedMatch && source.transaction_info?.source === 'route'
      ? safeRoute(namedMatch[2])
      : undefined);
  const methodCandidate =
    source.request?.method ??
    traceData['http.request.method'] ??
    traceData['http.method'] ??
    namedMatch?.[1];
  const method =
    typeof methodCandidate === 'string' && SAFE_METHOD.test(methodCandidate)
      ? methodCandidate
      : undefined;

  // Sans route paramétrée sûre, rien n'est envoyé : jamais de repli sur le chemin brut.
  if (!route || !method) return null;

  const safe: Record<string, unknown> = {
    type: 'transaction',
    transaction: `${method} ${route}`,
    transaction_info: { source: 'route' },
    request: { method, url: route },
    user: { ip_address: null },
    contexts: {
      trace: {
        trace_id: safeId(trace.trace_id, TRACE_ID),
        span_id: safeId(trace.span_id, SPAN_ID),
        parent_span_id: safeId(trace.parent_span_id, SPAN_ID),
        op: safeLabel(trace.op),
        status: safeLabel(trace.status),
        origin: safeLabel(trace.origin),
        data: traceData,
      },
    },
    spans: (source.spans ?? []).map(sanitizeSpan),
  };
  for (const key of [
    'event_id',
    'platform',
    'environment',
    'release',
    'start_timestamp',
    'timestamp',
  ]) {
    const value = source[key];
    if (typeof value === 'string' || typeof value === 'number') safe[key] = value;
  }
  return maskDeep(safe, 0) as T;
}
