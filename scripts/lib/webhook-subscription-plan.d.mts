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

export const ADMIN_API_TOPICS: AdminApiTopic[];
export const APP_LEVEL_ONLY_TOPICS: string[];
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

export function resolveAccessTokenForMode(params: {
  mode: string;
  shop: {
    shop_domain?: string;
    access_token_encrypted?: string | null;
    access_token_expires_at?: string | null;
    refresh_token_encrypted?: string | null;
    refresh_token_expires_at?: string | null;
    [key: string]: unknown;
  };
  app?: { clientId?: string; clientSecret?: string; [key: string]: unknown };
  decrypt: (encryptedToken: string) => string;
  refresh?: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  persistRefreshedToken?: (params: Record<string, unknown>) => Promise<{ ok: boolean }>;
  now?: number;
  refreshBufferMs?: number;
}): Promise<AccessTokenResult>;

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

export function controlledErrorMessage(error: unknown): string;
export function maskSensitiveText(value: unknown): unknown;

export function maskIngestUrl(rawUrl: unknown): string;

export function subscriptionsByGraphqlTopic(subscriptions: unknown[]): Map<string, unknown[]>;

export interface TopicPlanResult {
  action: string;
  detail: string;
  existingId?: string;
}

export function planTopicAction(params: {
  existingForTopic: unknown[];
  knownPublicId: string | null;
  ourOrigin: string;
}): TopicPlanResult;

export type ConnectionApplyDecision =
  | { kind: 'blocked_anomalie'; blocking: unknown[]; actionable: unknown[] }
  | { kind: 'already_conformant'; topics: unknown[] }
  | { kind: 'requires_rotation'; actionable: unknown[] }
  | { kind: 'provision'; actionable: unknown[] };

export function decideConnectionApplyPlan(params: {
  topics: unknown[];
  hasLocalToken: boolean;
}): ConnectionApplyDecision;
