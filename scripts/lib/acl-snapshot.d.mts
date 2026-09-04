// Déclarations de types pour acl-snapshot.mjs (module JS pur, allowJs=false dans
// ce dépôt — cf. tsconfig.json). Nécessaire depuis que ce module est consommé
// par un fichier .rls.test.ts (Lot S4), en plus de ses consommateurs Node purs
// existants (generate-acl-baseline.mjs, acl-baseline-at-version.mjs,
// acl-production-probe.mjs). Tenu synchronisé à la main avec les colonnes
// réellement retournées par collectFunctions() dans acl-snapshot.mjs — un
// écart ici n'affecte que le typage statique, jamais le comportement runtime.
import type { Client } from 'pg';

export const EXPOSED_SCHEMAS: string[];
export const BASELINE_SCHEMAS: string[];
export const KNOWN_ANON_EXECUTE_EXCEPTIONS: string[];

export type AclFunctionRow = {
  key: string;
  schema: string;
  name: string;
  args: string;
  returnType: string;
  securityDefiner: boolean;
  volatility: string | null;
  parallelSafety: string | null;
  owner: string;
  searchPathConfig: string;
  aclIsDefault: boolean;
  proaclSorted: string;
  anonExec: boolean;
  authenticatedExec: boolean;
  serviceRoleExec: boolean;
};

export type AclTableRow = {
  key: string;
  schema: string;
  name: string;
  owner: string;
  rlsEnabled: boolean;
  rlsForced: boolean;
  anonSelect: boolean;
  anonInsert: boolean;
  anonUpdate: boolean;
  anonDelete: boolean;
  authenticatedSelect: boolean;
  authenticatedInsert: boolean;
  authenticatedUpdate: boolean;
  authenticatedDelete: boolean;
  serviceRoleSelect: boolean;
  serviceRoleInsert: boolean;
  serviceRoleUpdate: boolean;
  serviceRoleDelete: boolean;
};

export type AclDefaultAclRow = {
  creatorRole: string;
  schema: string;
  objectType: string;
  aclSorted: string;
};

export type AclRoleMembershipRow = {
  member: string;
  of: string;
};

export type AclSnapshot = {
  exposedSchemas: string[];
  baselineSchemas: string[];
  knownAnonExecuteExceptions: string[];
  functions: AclFunctionRow[];
  tables: AclTableRow[];
  defaultAcl: AclDefaultAclRow[];
  roleMemberships: AclRoleMembershipRow[];
};

export function collectFunctions(client: Client, schemas?: string[]): Promise<AclFunctionRow[]>;
export function collectTables(client: Client, schemas?: string[]): Promise<AclTableRow[]>;
export function collectDefaultAcl(client: Client, schemas?: string[]): Promise<AclDefaultAclRow[]>;
export function collectRoleMemberships(client: Client): Promise<AclRoleMembershipRow[]>;
export function collectAclSnapshot(client: Client, schemas?: string[]): Promise<AclSnapshot>;
export function collectAppliedMigrationVersion(client: Client): Promise<string>;
