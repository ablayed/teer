// Déclaration ambiante minimale pour acl-classify.mjs — le fichier .mjs reste la
// SEULE source d'exécution (Node l'exécute directement, jamais compilé). Ce
// fichier n'existe que pour que tests/unit/security/acl-production-probe.test.ts
// (TypeScript, allowJs désactivé dans tsconfig.json) puisse importer les
// fonctions pures sans TS7016. Les types sont volontairement larges (`any`) —
// la correction du comportement est garantie par les tests, pas par ce fichier.

export interface AclObjectDiff {
  field: string;
  production: unknown;
  expected: unknown;
}

export interface AclFailure {
  category: string;
  objectType?: string;
  key: string;
  detail?: string;
  diffs?: AclObjectDiff[];
  entry?: unknown;
}

export interface AclPendingDeploy {
  objectType: string;
  key: string;
  detail: string;
}

export interface ClassifyResult {
  failures: AclFailure[];
  pendingDeploy: AclPendingDeploy[];
}

export function classifyAclObjects(params: {
  productionObjects: unknown[];
  versionedBaselineObjects: unknown[];
  currentBaselineObjects: unknown[];
  objectLabel: string;
}): ClassifyResult;

export function classifyAclSnapshot(params: {
  production: { functions: unknown[]; tables: unknown[] };
  versionedBaseline: { functions: unknown[]; tables: unknown[] };
  currentBaseline: { functions: unknown[]; tables: unknown[] };
}): ClassifyResult;

export function checkAbsoluteInvariant(params: {
  functions: unknown[];
  knownAnonExecuteExceptions?: string[];
  serviceRoleOnlyNames?: string[];
}): Array<{ category: string; key: string; detail: string }>;
