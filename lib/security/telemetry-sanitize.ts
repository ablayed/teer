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

function sanitizeBreadcrumb(breadcrumb: NonNullable<SentryLikeEvent['breadcrumbs']>[number]) {
  return {
    category: breadcrumb.category,
    level: breadcrumb.level,
    timestamp: breadcrumb.timestamp,
    type: breadcrumb.type,
  };
}

export function sanitizeSentryEvent<T extends object>(event: T): T {
  const safeEvent = event as T & SentryLikeEvent;

  if (safeEvent.request) {
    safeEvent.request = {
      method: safeEvent.request.method,
      url: sanitizePathname(safeEvent.request.url),
    };
  }

  if (safeEvent.breadcrumbs) {
    safeEvent.breadcrumbs = safeEvent.breadcrumbs.map(sanitizeBreadcrumb);
  }

  if (safeEvent.exception?.values) {
    safeEvent.exception.values = safeEvent.exception.values.map((value) => ({
      type: value.type,
      value: 'redacted_error',
    }));
  }

  if (safeEvent.message) {
    safeEvent.message = 'redacted_error';
  }

  if (safeEvent.extra) {
    const safeExtra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(safeEvent.extra)) {
      if (
        key === 'pathname' ||
        key === 'documentVisibilityState' ||
        key === 'navigatorOnline' ||
        key === 'networkRequestError' ||
        key === 'reactRecoverableError' ||
        key === 'actionName'
      ) {
        safeExtra[key] =
          key === 'pathname' && typeof value === 'string' ? sanitizePathname(value) : value;
      }
    }
    safeEvent.extra = safeExtra;
  }

  return event;
}

export function sanitizePostHogEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event) return null;
  if (!event.properties) return event;

  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event.properties as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey === 'q' ||
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

    if (normalizedKey.includes('url') || normalizedKey.includes('referrer')) {
      if (typeof value === 'string') {
        properties[key] = sanitizePathname(value);
      }
      continue;
    }

    properties[key] = value;
  }

  return { ...event, properties };
}
