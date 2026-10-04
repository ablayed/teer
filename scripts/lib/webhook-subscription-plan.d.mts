// Déclaration ambiante minimale pour webhook-subscription-plan.mjs — le fichier .mjs reste la
// SEULE source d'exécution (Node l'exécute directement, jamais compilé). Ce fichier n'existe que
// pour que tests/unit/shopify/webhook-subscription-plan.test.ts (TypeScript, allowJs désactivé
// dans tsconfig.json) puisse importer les fonctions pures sans TS7016. Les types sont
// volontairement larges (`unknown`/`any`) — la correction du comportement est garantie par les
// tests, pas par ce fichier.

export interface AdminApiTopic {
  rest: string;
  graphql: string;
}

export const ADMIN_API_TOPICS: readonly AdminApiTopic[];
export const PER_SHOP_SUBSCRIPTION_TOPICS: readonly AdminApiTopic[];
export const APP_LEVEL_ONLY_TOPICS: string[];
export const APP_LEVEL_BY_DECISION_TOPICS: string[];
export const APP_LEVEL_TOPICS: string[];
export const INGEST_PATH_PREFIX: string;

export type SelectionResult = { ok: true; shopDomain: string } | { ok: false; reason: string };

export function validateShopDomainSelection(rawDomain: unknown): SelectionResult;
export function resolveSingleShopSelection(
  shops: Array<{ shop_domain: string; [key: string]: unknown }>,
  shopDomain: string,
):
  | { ok: true; shop: { shop_domain: string; [key: string]: unknown } }
  | { ok: false; reason: string };
export function resolveSingleConnectionSelection(
  connections: unknown[],
): { ok: true; connection: unknown } | { ok: false; reason: string };

export function accessTokenNeedsRenewal(
  expiresAt: string | null | undefined,
  now?: number,
  refreshBufferMs?: number,
): boolean;

export type AccessTokenResult = { ok: true; accessToken: string } | { ok: false; reason: string };

export function resolvePlanAccessToken(params: {
  encryptedToken: string | null | undefined;
  expiresAt: string | null | undefined;
  decrypt: (encryptedToken: string) => string;
  now?: number;
  refreshBufferMs?: number;
}): AccessTokenResult;

export function scopeShopQuery(
  query: { eq: (field: string, value: string) => unknown },
  shopDomain: string,
): unknown;
export function scopeActiveConnectionQuery(
  query: {
    eq: (field: string, value: string) => unknown;
  },
  shopId: string,
): unknown;

export function withPlanFailure<T>(code: string, operation: () => T | Promise<T>): Promise<T>;
export function controlledErrorMessage(error: unknown): string;
export function maskSensitiveText(value: unknown): unknown;

export interface ClassifiedSubscriptionLike {
  topic: string;
  classification: { kind: 'current' | 'previous' | 'foreign'; onOurOrigin?: boolean };
}

export interface TopicState {
  topic: string;
  graphqlTopic: string;
  state: 'conforme' | 'precedent' | 'absent';
  current: number;
  previous: number;
  foreign: number;
  doublons: number;
}

export function summarizeTopicStates(
  classified: readonly ClassifiedSubscriptionLike[],
  expectedTopics: readonly AdminApiTopic[],
): TopicState[];

export function summarizeReconcileOutlook(
  topicStates: readonly TopicState[],
): 'aucune_action' | 'creation_sans_rotation' | 'rotation';
