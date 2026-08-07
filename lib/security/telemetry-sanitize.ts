import type { CaptureResult } from 'posthog-js';

type SentryLikeEvent = {
  message?: string;
  request?: {
    method?: string;
    url?: string;
    query_string?: unknown;
    headers?: unknown;
    data?: unknown;
    [key: string]: unknown;
  };
  breadcrumbs?: Array<{
    category?: string;
    level?: string;
    timestamp?: number;
    type?: string;
    [key: string]: unknown;
  }>;
  exception?: {
    values?: Array<{ type?: string; value?: string; [key: string]: unknown }>;
    [key: string]: unknown;
  };
  transaction?: string;
  extra?: Record<string, unknown>;
  [key: string]: unknown;
};

export function sanitizePathname(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value, 'https://teer.invalid');
    return parsed.pathname || '/';
  } catch {
    const pathname = value.split(/[?#]/, 1)[0];
    return pathname.startsWith('/') ? pathname : undefined;
  }
}

function sanitizeTelemetryPath(value: string | null | undefined): string | undefined {
  const pathname = sanitizePathname(value);
  if (
    !pathname ||
    pathname.length > 160 ||
    pathname.includes('@') ||
    [...pathname].some((character) => character.charCodeAt(0) < 32)
  ) {
    return undefined;
  }

  return pathname
    .split('/')
    .map((segment) => {
      if (!segment) return segment;
      return /^[a-z][a-z0-9_-]{0,40}$/.test(segment) ? segment : ':id';
    })
    .join('/');
}

function sanitizeTechnicalLabel(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z0-9_$][a-z0-9_$.:/-]{0,79}$/.test(value)
    ? value
    : undefined;
}

function sanitizeBreadcrumb(breadcrumb: NonNullable<SentryLikeEvent['breadcrumbs']>[number]) {
  return {
    category: sanitizeTechnicalLabel(breadcrumb.category),
    level: sanitizeTechnicalLabel(breadcrumb.level),
    timestamp: breadcrumb.timestamp,
    type: sanitizeTechnicalLabel(breadcrumb.type),
  };
}

export function sanitizeSentryEvent<T extends object>(event: T): T {
  const source = event as T & SentryLikeEvent;
  const safeEvent = {} as T & SentryLikeEvent;

  for (const key of [
    'level',
    'platform',
    'logger',
    'timestamp',
    'event_id',
    'environment',
    'release',
  ]) {
    if (key in source) {
      (safeEvent as Record<string, unknown>)[key] = source[key];
    }
  }

  if (source.tags && typeof source.tags === 'object') {
    const safeTags: Record<string, string> = {};
    for (const [key, value] of Object.entries(source.tags as Record<string, unknown>)) {
      const safeValue = sanitizeTechnicalLabel(value);
      if (safeValue) safeTags[key] = safeValue;
    }
    (safeEvent as Record<string, unknown>).tags = safeTags;
  }

  if (source.transaction) {
    const safeTransaction = sanitizeTechnicalLabel(source.transaction);
    if (safeTransaction) safeEvent.transaction = safeTransaction;
  }

  if (source.request) {
    safeEvent.request = {
      method: sanitizeTechnicalLabel(source.request.method),
      url: sanitizeTelemetryPath(source.request.url),
    };
  }

  if (source.breadcrumbs) {
    safeEvent.breadcrumbs = source.breadcrumbs.map(sanitizeBreadcrumb);
  }

  if (source.exception?.values) {
    safeEvent.exception = {
      values: source.exception.values.map((value) => ({
        type: sanitizeTechnicalLabel(value.type),
        value: 'redacted_error',
      })),
    };
  }

  if (source.message) {
    safeEvent.message = 'redacted_error';
  }

  if (source.extra) {
    const safeExtra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source.extra)) {
      if (key === 'pathname' && typeof value === 'string') {
        safeExtra[key] = sanitizeTelemetryPath(value);
      } else if (key === 'documentVisibilityState' || key === 'actionName') {
        const safeValue = sanitizeTechnicalLabel(value);
        if (safeValue) safeExtra[key] = safeValue;
      } else if (
        (key === 'navigatorOnline' ||
          key === 'networkRequestError' ||
          key === 'reactRecoverableError') &&
        typeof value === 'boolean'
      ) {
        safeExtra[key] = value;
      }
    }
    safeEvent.extra = safeExtra;
  }

  return safeEvent;
}

/*
 * Deliberately keep the PostHog allowlist small. Unknown string properties are
 * dropped instead of being guessed safe; numbers and booleans remain useful
 * for aggregate product telemetry without carrying customer content.
 */
export function sanitizePostHogEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event) return null;

  const safeEventName =
    typeof event.event === 'string' && /^[a-z0-9_$][a-z0-9_$.-]{0,79}$/.test(event.event)
      ? event.event
      : 'redacted_event';
  const safeEvent = {} as CaptureResult;
  for (const key of ['event', 'timestamp', 'uuid', 'distinct_id', '$set', '$set_once', '$unset']) {
    if (key in event) {
      (safeEvent as unknown as Record<string, unknown>)[key] =
        key === 'event' ? safeEventName : (event as unknown as Record<string, unknown>)[key];
    }
  }

  if (!event.properties) return safeEvent;

  const safeStringKeys = new Set([
    '$browser',
    '$browser_version',
    '$device_type',
    '$host',
    '$os',
    '$os_version',
    '$pathname',
    '$referrer',
    '$referring_domain',
    'action',
    'action_name',
    'component',
    'event_type',
    'feature',
    'pathname',
    'result',
    'section',
    'source',
    'status',
    'surface',
  ]);
  const safeTechnicalValue = (key: string, value: unknown): unknown => {
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      return value;
    }
    if (typeof value !== 'string' || !safeStringKeys.has(key)) {
      return undefined;
    }
    if (key.includes('url') || key.includes('referrer') || key === 'pathname') {
      return sanitizeTelemetryPath(value);
    }
    return sanitizeTechnicalLabel(value);
  };

  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event.properties as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey === 'q' ||
      normalizedKey === 'name' ||
      normalizedKey === 'fullname' ||
      normalizedKey.endsWith('_name') ||
      normalizedKey.includes('phone') ||
      normalizedKey.includes('telephone') ||
      normalizedKey.includes('email') ||
      normalizedKey.includes('address') ||
      normalizedKey.includes('signed') ||
      normalizedKey.includes('query') ||
      normalizedKey.includes('search') ||
      normalizedKey.includes('token') ||
      normalizedKey.includes('message') ||
      normalizedKey.includes('payload') ||
      normalizedKey.includes('body') ||
      normalizedKey.includes('exception') ||
      normalizedKey.includes('stack')
    ) {
      continue;
    }

    const safeValue = safeTechnicalValue(key, value);
    if (safeValue !== undefined) {
      properties[key] = safeValue;
    }
  }

  return { ...safeEvent, properties };
}
