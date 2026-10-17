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

export function sanitizeTelemetryPath(value: string | null | undefined): string | undefined {
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

// Groupement des erreurs dans Sentry : Sentry regroupe par pile d'appels, à défaut par type et valeur.
// Effacer la pile ET la valeur donnait un titre unique (`redacted_error`) et un seul ticket pour toutes
// les erreurs. Sont conservés les éléments qui décrivent le CODE et jamais une donnée : type d'erreur,
// mécanisme, fichier (chemin sans origine ni paramètres), nom de fonction, position, et un code d'erreur
// métier de la liste blanche (`UNEXPECTED_ERROR`, `FORBIDDEN`). Le texte libre d'une erreur (il peut contenir un
// nom, un numéro, une adresse) reste toujours effacé, ainsi que le contexte source et les variables.
// Liste blanche explicite : un motif « capitales » laisserait passer n'importe quelle valeur écrite ainsi.
const SAFE_ERROR_CODES = new Set(['UNEXPECTED_ERROR', 'UNAUTHENTICATED', 'FORBIDDEN']);
const ERROR_TYPE_PATTERN = /^[A-Z][A-Za-z0-9]{0,60}(Error|Exception)$|^Error$/;
const FUNCTION_NAME_PATTERN = /^[A-Za-z0-9_$.<>[\] ]{1,80}$/;
const MAX_STACK_FRAMES = 50;

function sanitizeFrameFilename(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const path = sanitizePathname(value);
  if (!path || path.length > 200 || path.includes('@') || /\s/.test(path)) return undefined;
  return path;
}

function sanitizeStackFrame(frame: Record<string, unknown>) {
  const safe: Record<string, unknown> = {};
  const filename = sanitizeFrameFilename(frame.filename);
  if (filename) safe.filename = filename;
  if (typeof frame.function === 'string' && FUNCTION_NAME_PATTERN.test(frame.function)) {
    safe.function = frame.function;
  }
  for (const key of ['lineno', 'colno']) {
    const number = frame[key];
    if (typeof number === 'number' && Number.isFinite(number)) safe[key] = number;
  }
  if (typeof frame.in_app === 'boolean') safe.in_app = frame.in_app;
  return safe;
}

function sanitizeExceptionValue(value: {
  type?: string;
  value?: string;
  mechanism?: { type?: unknown; handled?: unknown };
  stacktrace?: { frames?: unknown };
  [key: string]: unknown;
}) {
  const safe: Record<string, unknown> = {
    type:
      typeof value.type === 'string' && ERROR_TYPE_PATTERN.test(value.type)
        ? value.type
        : undefined,
    value:
      typeof value.value === 'string' && SAFE_ERROR_CODES.has(value.value)
        ? value.value
        : 'redacted_error',
  };
  const mechanismType = sanitizeTechnicalLabel(value.mechanism?.type);
  if (mechanismType) {
    safe.mechanism = {
      type: mechanismType,
      ...(typeof value.mechanism?.handled === 'boolean'
        ? { handled: value.mechanism.handled }
        : {}),
    };
  }
  const frames = value.stacktrace?.frames;
  if (Array.isArray(frames)) {
    safe.stacktrace = {
      frames: frames
        .slice(-MAX_STACK_FRAMES)
        .filter((frame): frame is Record<string, unknown> => !!frame && typeof frame === 'object')
        .map(sanitizeStackFrame),
    };
  }
  return safe;
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

  // Adresse IP explicitement nulle : Sentry n'en déduit ni adresse ni géolocalisation (le SDK laisse
  // une valeur nulle telle quelle, voir `addAutoIpAddressToUser`).
  (safeEvent as Record<string, unknown>).user = { ip_address: null };

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
      values: source.exception.values.map(sanitizeExceptionValue),
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

// SHOPIFY-WEBHOOKS-PER-SHOP-1B / C8 — secret du jeton L3 dans le CHEMIN de la requête.
//
// L'URL d'ingestion Shopify porte son secret dans son dernier segment
// (`/api/shopify/ingest/{publicId}.{secret}`). Les événements d'ERREUR passent par
// `sanitizeSentryEvent`, qui réduit déjà ce segment à `:id`. Les TRANSACTIONS (traces de
// performance, échantillonnées) n'y passent pas : Sentry ne leur applique pas `beforeSend`, et
// elles portent l'URL brute de la requête (`request.url`, attributs `http.target`, `http.url`,
// `url.full` des spans). Sans `beforeSendTransaction`, le secret partait donc avec elles.
//
// Les journaux de requêtes de la plateforme d'hébergement sont hors de portée de ce code.
const OPAQUE_INGEST_PATH = /(\/api\/shopify\/ingest\/)[^/?#\s"'<>\\]+/g;
const MAX_SANITIZE_DEPTH = 12;

export function maskOpaqueIngestPath(value: string): string {
  return value.replace(OPAQUE_INGEST_PATH, '$1:token');
}

export function maskDeep(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return maskOpaqueIngestPath(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= MAX_SANITIZE_DEPTH) {
    // Au-delà de la profondeur bornée, rien n'est transmis plutôt que transmis non masqué.
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => maskDeep(entry, depth + 1));
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[maskOpaqueIngestPath(key)] = maskDeep(entry, depth + 1);
  }
  return output;
}

// `beforeSendTransaction` : toute chaîne de l'événement est masquée, où qu'elle se trouve (nom de
// transaction, requête, contexte de trace, attributs et description de chaque span). Le reste de
// l'événement est transmis tel quel.
export function sanitizeSentryTransaction<T extends object>(event: T): T {
  return maskDeep(event, 0) as T;
}
