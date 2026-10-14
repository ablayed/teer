// Origine d'une erreur de traitement de webhook : ce qu'on peut en garder SANS donnée.
//
// Le pipeline réduit chaque échec à un code contrôlé (`shopify_order_persist_failed`,
// `shopify_pcd_audit_failed`…). Ce code dit OÙ le traitement s'est arrêté, jamais POURQUOI :
// l'erreur d'origine était jetée. Ce module en garde l'empreinte technique — code SQLSTATE ou
// PostgREST, nom de contrainte, statut HTTP, nature — et rien d'autre. Jamais le message brut,
// ni `details`, ni `hint` : Postgres y recopie des valeurs de ligne.
//
// Module pur : aucune dépendance.

export type ErrorOriginKind = 'database' | 'http' | 'network' | 'unknown';

export type ErrorOrigin = {
  // SQLSTATE (`23505`), code PostgREST (`PGRST301`) ou statut HTTP (`502`).
  code: string | null;
  // Nom de la contrainte en cause, quand le message Postgres en nomme une.
  constraint: string | null;
  kind: ErrorOriginKind;
};

export const UNIQUE_VIOLATION = '23505';

const CODE = /^[A-Za-z0-9]{2,12}$/;
const CONSTRAINT = /constraint "([a-z0-9_]{1,63})"/;
const MAX_CAUSE_DEPTH = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readCode(value: Record<string, unknown>): string | null {
  const code = value.code;
  return typeof code === 'string' && CODE.test(code) ? code : null;
}

function readStatus(value: Record<string, unknown>): string | null {
  const status = value.status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599
    ? String(status)
    : null;
}

function readConstraint(value: Record<string, unknown>): string | null {
  const message = value.message;
  return typeof message === 'string' ? (CONSTRAINT.exec(message)?.[1] ?? null) : null;
}

function isNetworkFailure(value: Record<string, unknown>): boolean {
  const name = value.name;
  const message = value.message;
  // Le client PostgREST rend le statut 0 quand la requête n'a reçu aucune réponse.
  if (value.status === 0) return true;
  return (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    (name === 'TypeError' && typeof message === 'string' && message.includes('fetch failed'))
  );
}

/**
 * L'erreur d'un résultat Supabase, accompagnée du statut HTTP de la réponse. Une écriture coupée
 * par une passerelle ne porte aucun code SQL : sans le statut, son origine serait inconnue.
 */
export function errorWithStatus(error: unknown, status: unknown): unknown {
  return isRecord(error) && typeof status === 'number' ? { ...error, status } : error;
}

/** Empreinte technique d'une erreur, en remontant sa chaîne de `cause`. Jamais de texte libre. */
export function describeErrorOrigin(error: unknown): ErrorOrigin {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && isRecord(current); depth += 1) {
    const code = readCode(current);
    if (code) {
      return { code, constraint: readConstraint(current), kind: 'database' };
    }
    const status = readStatus(current);
    if (status) {
      return { code: status, constraint: null, kind: 'http' };
    }
    if (isNetworkFailure(current)) {
      return { code: null, constraint: null, kind: 'network' };
    }
    current = current.cause;
  }
  return { code: null, constraint: null, kind: 'unknown' };
}

/**
 * Code durable d'un échec : le code contrôlé, suivi de l'origine quand elle est connue
 * (`shopify_order_persist_failed__23505`). Conforme à la contrainte de
 * `finish_shopify_webhook_event` : `^[a-z0-9_]{1,64}$`.
 */
export function durableErrorCode(controlledCode: string, origin: ErrorOrigin | null): string {
  const suffix = origin?.code
    ? origin.code.toLowerCase()
    : origin?.kind === 'network'
      ? 'network'
      : null;
  return suffix ? `${controlledCode}__${suffix}`.slice(0, 64) : controlledCode;
}

/**
 * L'origine d'un échec de traitement, quand elle est connue : celle d'une
 * `WebhookProcessingError`, ou celle que porte la chaîne de `cause` d'une erreur ordinaire.
 * `null` sinon — un code contrôlé sans origine reste inchangé.
 */
export function knownErrorOrigin(error: unknown): ErrorOrigin | null {
  if (error instanceof WebhookProcessingError) {
    return error.origin.kind === 'unknown' ? null : error.origin;
  }
  if (!isRecord(error) || error.cause === undefined) {
    return null;
  }
  const origin = describeErrorOrigin(error.cause);
  return origin.kind === 'unknown' ? null : origin;
}

/** Le code contrôlé d'un code durable : ce qui précède l'origine. */
export function controlledPart(durableCode: string): string {
  return durableCode.split('__')[0] ?? durableCode;
}

/**
 * Échec de traitement : `message` reste le code contrôlé (les classements existants le lisent),
 * `origin` porte l'empreinte de l'erreur d'origine.
 */
export class WebhookProcessingError extends Error {
  readonly origin: ErrorOrigin;

  // `cause` : l'erreur d'origine, ou son empreinte quand l'appelant l'a déjà relevée.
  constructor(controlledCode: string, cause: unknown) {
    super(controlledCode, { cause });
    this.name = 'WebhookProcessingError';
    this.origin = isErrorOrigin(cause) ? cause : describeErrorOrigin(cause);
  }
}

function isErrorOrigin(value: unknown): value is ErrorOrigin {
  return (
    isRecord(value) &&
    'constraint' in value &&
    'code' in value &&
    (value.kind === 'database' ||
      value.kind === 'http' ||
      value.kind === 'network' ||
      value.kind === 'unknown')
  );
}
