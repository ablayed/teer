#!/usr/bin/env node
// Phase 2 / Lot 4A — Couche 2 : baseline ACL déterministe, régénérable sur demande.
//
// NE remplace PAS la couche 1 (tests/rls/function-execute-acl-invariant.rls.test.ts),
// qui mesure l'ACL EXECUTE réelle et échoue sans possibilité de régénération. Cette
// baseline couvre ce que la couche 1 ne couvre pas : grants `authenticated`, owner,
// mode de sécurité, search_path, volatilité, parallélisme, schémas exposés, privilèges
// par défaut, appartenances de rôle. Elle EST destinée à être régénérée délibérément —
// ces attributs changent pour de bonnes raisons à chaque lot. Voir CLAUDE.md, section
// "Lot 4A — détection de l'exposition ACL", pour la procédure de mise à jour.
//
// Déterminisme strict : aucun OID, aucun horodatage, aucune version de plateforme, tri
// explicite et complet, clé de fonction = schéma.nom(types d'arguments). Deux rejeux
// propres doivent produire un fichier identique octet pour octet — vérifié par
// `pnpm security:acl-baseline:check`.
//
// Périmètre : schémas `public` et `private`, plus les schémas exposés PostgREST
// (`supabase/config.toml`, `api.schemas`). Exclut délibérément les schémas gérés par
// la plateforme (`auth`, `storage`, `extensions`, `realtime`, `vault`, etc.) — ils
// changent à chaque mise à jour Supabase, et un contrôle bruyant est désactivé sous
// trois semaines.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const { Client } = pg;

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const BASELINE_PATH = resolve(PROJECT_ROOT, 'supabase/security/acl-baseline.json');

// Doit rester synchronisé avec `supabase/config.toml:6` (`api.schemas`) et avec
// `tests/rls/function-execute-acl-invariant.rls.test.ts` (`EXPOSED_SCHEMAS`).
const EXPOSED_SCHEMAS = ['public', 'graphql_public'];

// Schémas couverts par la baseline en plus des schémas exposés : `private` n'est pas
// exposé PostgREST mais héberge le cœur `post_stock_movement` (0136) — surveillé ici
// pour la même raison que les schémas exposés (dérive de owner/security/search_path).
const BASELINE_SCHEMAS = ['public', 'private', 'graphql_public'];

const dbUrl =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

function sortObjectKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortObjectKeys(value[key])]),
    );
  }
  return value;
}

// Formaté via Biome (le formatter du projet, `pnpm lint`), pas via `JSON.stringify`
// brut : Biome collapse les tableaux courts sur une seule ligne, ce que
// `JSON.stringify(..., null, 2)` ne fait jamais — un désaccord de formatage sur ce
// fichier committé ferait échouer `pnpm lint` en CI sans rapport avec l'ACL elle-même.
// Biome étant lui-même déterministe, ce passage ne casse pas la reproductibilité.
function stableStringify(value) {
  const raw = `${JSON.stringify(sortObjectKeys(value), null, 2)}\n`;
  const result = spawnSync(`pnpm exec biome format --stdin-file-path="${BASELINE_PATH}"`, {
    input: raw,
    encoding: 'utf8',
    shell: true,
  });
  if (result.status !== 0) {
    throw new Error(`biome format failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function main() {
  const client = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 10_000 });
  await client.connect();

  try {
    const { rows: functions } = await client.query(
      `
        select
          n.nspname as schema_name,
          p.proname as func_name,
          pg_get_function_identity_arguments(p.oid) as args,
          t.typname as return_type,
          p.prosecdef as security_definer,
          case p.provolatile
            when 'i' then 'immutable'
            when 's' then 'stable'
            when 'v' then 'volatile'
          end as volatility,
          case p.proparallel
            when 's' then 'safe'
            when 'r' then 'restricted'
            when 'u' then 'unsafe'
          end as parallel_safety,
          o.rolname as owner,
          coalesce(
            (select string_agg(cfg, ',' order by cfg) from unnest(coalesce(p.proconfig, array[]::text[])) as cfg),
            ''
          ) as search_path_config,
          p.proacl is null as acl_is_default,
          coalesce(
            (
              select string_agg(a, ',' order by a)
              from unnest(case when p.proacl is null then array[]::text[] else p.proacl::text[] end) as a
            ),
            ''
          ) as proacl_sorted,
          has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_exec,
          has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_exec
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        join pg_roles o on o.oid = p.proowner
        join pg_type t on t.oid = p.prorettype
        where n.nspname = any($1::text[])
        order by n.nspname, p.proname, args
      `,
      [BASELINE_SCHEMAS],
    );

    const { rows: defaultAcl } = await client.query(
      `
        select
          r.rolname as creator_role,
          coalesce(n.nspname, '(database-wide)') as schema_name,
          case d.defaclobjtype
            when 'r' then 'table'
            when 'f' then 'function'
            when 'S' then 'sequence'
            when 'T' then 'type'
            else d.defaclobjtype::text
          end as object_type,
          coalesce(
            (select string_agg(a, ',' order by a) from unnest(d.defaclacl::text[]) as a),
            ''
          ) as acl_sorted
        from pg_default_acl d
        join pg_roles r on r.oid = d.defaclrole
        left join pg_namespace n on n.oid = d.defaclnamespace
        where n.nspname is null or n.nspname = any($1::text[])
        order by creator_role, schema_name, object_type
      `,
      [BASELINE_SCHEMAS],
    );

    const { rows: roleMemberships } = await client.query(
      `
        select m.rolname as member_role, o.rolname as of_role
        from pg_auth_members am
        join pg_roles m on m.oid = am.member
        join pg_roles o on o.oid = am.roleid
        where m.rolname in ('anon', 'authenticated', 'service_role', 'postgres')
           or o.rolname in ('anon', 'authenticated', 'service_role', 'postgres')
        order by of_role, member_role
      `,
    );

    const baseline = {
      exposedSchemas: [...EXPOSED_SCHEMAS].sort(),
      baselineSchemas: [...BASELINE_SCHEMAS].sort(),
      knownAnonExecuteExceptions: [
        'graphql_public.graphql("operationName" text, query text, variables jsonb, extensions jsonb)',
      ],
      functions: functions.map((f) => ({
        key: `${f.schema_name}.${f.func_name}(${f.args})`,
        schema: f.schema_name,
        name: f.func_name,
        args: f.args,
        returnType: f.return_type,
        securityDefiner: f.security_definer,
        volatility: f.volatility,
        parallelSafety: f.parallel_safety,
        owner: f.owner,
        searchPathConfig: f.search_path_config,
        aclIsDefault: f.acl_is_default,
        proaclSorted: f.proacl_sorted,
        anonExec: f.anon_exec,
        authenticatedExec: f.authenticated_exec,
        serviceRoleExec: f.service_role_exec,
      })),
      defaultAcl: defaultAcl.map((d) => ({
        creatorRole: d.creator_role,
        schema: d.schema_name,
        objectType: d.object_type,
        aclSorted: d.acl_sorted,
      })),
      roleMemberships: roleMemberships.map((m) => ({
        member: m.member_role,
        of: m.of_role,
      })),
    };

    const output = stableStringify(baseline);

    if (process.argv.includes('--check')) {
      let existing;
      try {
        existing = readFileSync(BASELINE_PATH, 'utf8');
      } catch {
        process.stderr.write(
          `ACL baseline check failed: ${BASELINE_PATH} is missing. Run "node scripts/generate-acl-baseline.mjs" and commit it.\n`,
        );
        process.exitCode = 1;
        return;
      }

      if (existing !== output) {
        process.stderr.write('ACL baseline check failed: committed baseline is stale.\n');
        process.stderr.write(
          'Run "node scripts/generate-acl-baseline.mjs" locally, review the diff, and commit it in the same commit as the migration that changed the surface.\n',
        );
        process.exitCode = 1;
        return;
      }

      process.stdout.write('ACL baseline check passed: committed baseline matches live state.\n');
      return;
    }

    writeFileSync(BASELINE_PATH, output, 'utf8');
    process.stdout.write(`ACL baseline written to ${BASELINE_PATH}\n`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`ACL baseline generation failed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
