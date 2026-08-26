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
