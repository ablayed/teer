type UnknownRecord = Record<string, unknown>;

const WEB_VITALS = new Set(['cls', 'fcp', 'inp', 'lcp', 'ttfb']);
const SAFE_OPERATIONS =
  /^(?:pageload|navigation|resource|ui\.long-task|ui\.interaction|http\.client)$/;

function record(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

export function routeFromPathname(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  const direct = new Set(['/commandes', '/tableau', '/livreurs']);
  if (direct.has(path)) return path;
  if (/^\/commandes\/[^/]+$/.test(path)) return '/commandes/[id]';

  const scoped = path.match(/^\/s\/[^/]+\/(commandes|tableau|livreurs)(?:\/([^/]+))?$/);
  if (!scoped) return null;
  if (scoped[1] === 'commandes' && scoped[2]) return '/s/[shop]/commandes/[id]';
  if (scoped[2]) return null;
  return `/s/[shop]/${scoped[1]}`;
}

function routeForTransaction(event: UnknownRecord): string | null {
  const requestUrl = record(event.request)?.url;
  if (typeof requestUrl === 'string') {
    try {
      const route = routeFromPathname(new URL(requestUrl).pathname);
      if (route) return route;
    } catch {
      // Fall through to the SDK transaction name, which may already contain a route template.
    }
  }

  if (typeof event.transaction !== 'string') return null;
  const path = event.transaction.match(/(?:^|\s)(\/[^\s?#]*)/)?.[1];
  return path ? routeFromPathname(path) : null;
}

function safeMeasurements(value: unknown): UnknownRecord {
  const input = record(value);
  if (!input) return {};
  const output: UnknownRecord = {};

  for (const [name, rawMeasurement] of Object.entries(input)) {
    if (!WEB_VITALS.has(name)) continue;
    const measurement = record(rawMeasurement);
    if (
      !measurement ||
      typeof measurement.value !== 'number' ||
      !Number.isFinite(measurement.value)
    ) {
      continue;
    }
    const unit = measurement.unit;
    if (unit !== 'millisecond' && unit !== 'second' && unit !== 'none') continue;
    output[name] = { value: measurement.value, unit };
  }

  return output;
}

function safeSpans(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((rawSpan) => {
    const span = record(rawSpan);
    if (!span || typeof span.op !== 'string' || !SAFE_OPERATIONS.test(span.op)) return [];
    if (typeof span.start_timestamp !== 'number' || typeof span.timestamp !== 'number') return [];

    return [
      {
        ...(typeof span.span_id === 'string' ? { span_id: span.span_id } : {}),
        ...(typeof span.trace_id === 'string' ? { trace_id: span.trace_id } : {}),
        ...(typeof span.parent_span_id === 'string' ? { parent_span_id: span.parent_span_id } : {}),
        op: span.op,
        start_timestamp: span.start_timestamp,
        timestamp: span.timestamp,
        ...(typeof span.status === 'string' ? { status: span.status } : {}),
      },
    ];
  });
}

/** Allowlist only navigation timing and Web Vitals; drop URLs, queries, users, cookies and payloads. */
export function sanitizeSentryClientTransaction<T extends object>(event: T): T | null {
  const input = event as UnknownRecord;
  const route = routeForTransaction(input);
  if (!route) return null;

  const trace = record(record(input.contexts)?.trace);
  const rawOperation = trace?.op;
  const transactionPrefix =
    typeof input.transaction === 'string' ? input.transaction.split(' ')[0] : '';
  const navigationType =
    rawOperation === 'pageload' || rawOperation === 'navigation'
      ? rawOperation
      : transactionPrefix === 'pageload' || transactionPrefix === 'navigation'
        ? transactionPrefix
        : 'unknown';

  return {
    ...(typeof input.event_id === 'string' ? { event_id: input.event_id } : {}),
    ...(typeof input.type === 'string' ? { type: input.type } : {}),
    ...(typeof input.timestamp === 'number' ? { timestamp: input.timestamp } : {}),
    ...(typeof input.start_timestamp === 'number'
      ? { start_timestamp: input.start_timestamp }
      : {}),
    ...(typeof input.platform === 'string' ? { platform: input.platform } : {}),
    ...(typeof input.release === 'string' ? { release: input.release } : {}),
    ...(typeof input.environment === 'string' ? { environment: input.environment } : {}),
    ...(typeof input.dist === 'string' ? { dist: input.dist } : {}),
    ...(input.sdk ? { sdk: input.sdk } : {}),
    transaction: `${navigationType} ${route}`,
    transaction_info: { source: 'route' },
    contexts: trace
      ? {
          trace: {
            ...(typeof trace.trace_id === 'string' ? { trace_id: trace.trace_id } : {}),
            ...(typeof trace.span_id === 'string' ? { span_id: trace.span_id } : {}),
            ...(typeof trace.parent_span_id === 'string'
              ? { parent_span_id: trace.parent_span_id }
              : {}),
            ...(typeof trace.status === 'string' ? { status: trace.status } : {}),
            op: navigationType,
          },
        }
      : undefined,
    tags: { route, navigation_type: navigationType },
    measurements: safeMeasurements(input.measurements),
    spans: safeSpans(input.spans),
  } as T;
}

const STANDALONE_SPAN_DATA_KEYS = new Set([
  'sentry.origin',
  'sentry.op',
  'sentry.source',
  'sentry.exclusive_time',
  'sentry.sample_rate',
  'release',
  'environment',
]);

/**
 * Les spans autonomes (interaction → INP) ne passent PAS par `beforeSendTransaction` : leur
 * `data.transaction` porte le chemin brut (identifiant de boutique compris), leur description
 * peut nommer un élément. Liste blanche des clés, route normalisée, description réduite à l'opération.
 */
export function sanitizeSentryClientSpan<
  T extends { data?: Record<string, unknown>; description?: string; op?: string },
>(span: T): T {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(span.data ?? {})) {
    if (STANDALONE_SPAN_DATA_KEYS.has(key)) data[key] = value;
  }
  const rawTransaction = span.data?.transaction;
  if (typeof rawTransaction === 'string') {
    const route = routeFromPathname(rawTransaction.split(/[?#]/)[0] ?? '');
    if (route) data.transaction = route;
  }
  return { ...span, data, description: span.op ?? span.description };
}
