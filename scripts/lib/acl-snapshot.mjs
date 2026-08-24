// Phase 2 / Lot 4A-4B — mesures ACL partagées entre trois consommateurs :
//   - scripts/generate-acl-baseline.mjs (baseline locale committée, Couche 2)
//   - scripts/acl-baseline-at-version.mjs (baseline versionnée jetable, Lot 4B)
//   - scripts/acl-production-probe.mjs (mesure LIVE en production, Lot 4B)
// Extrait de generate-acl-baseline.mjs pour que les trois lisent EXACTEMENT les
// mêmes colonnes de la même façon — une divergence de requête entre le générateur
// de baseline et la sonde de production invaliderait toute comparaison.
//
// Ce module ne fait aucune hypothèse sur le rôle connecté : il fonctionne aussi
// bien sous `postgres` (génération locale, tous privilèges) que sous
// `ci_schema_auditor` (sonde production, aucun privilège au-delà des grants du
// Lot 4B) — les requêtes ne lisent que des catalogues système ouverts à PUBLIC,
// jamais une table applicative.

// Doit rester synchronisé avec supabase/config.toml:6 (api.schemas) et avec
// tests/rls/function-execute-acl-invariant.rls.test.ts (EXPOSED_SCHEMAS).
export const EXPOSED_SCHEMAS = ['public', 'graphql_public'];

// Schémas couverts par la baseline en plus des schémas exposés : `private`
// héberge le cœur post_stock_movement (0136) — surveillé pour la même raison
// que les schémas exposés (dérive de owner/security/search_path).
export const BASELINE_SCHEMAS = ['public', 'private', 'graphql_public'];

export const KNOWN_ANON_EXECUTE_EXCEPTIONS = [
  'graphql_public.graphql("operationName" text, query text, variables jsonb, extensions jsonb)',
];

export async function collectFunctions(client, schemas = BASELINE_SCHEMAS) {
  const { rows } = await client.query(
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
    [schemas],
  );

  return rows.map((f) => ({
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
  }));
}

export async function collectTables(client, schemas = BASELINE_SCHEMAS) {
  const { rows } = await client.query(
    `
      select
        n.nspname as schema_name,
        c.relname as table_name,
        o.rolname as owner,
        c.relrowsecurity as rls_enabled,
        c.relforcerowsecurity as rls_forced,
        has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
        has_table_privilege('anon', c.oid, 'INSERT') as anon_insert,
        has_table_privilege('anon', c.oid, 'UPDATE') as anon_update,
        has_table_privilege('anon', c.oid, 'DELETE') as anon_delete,
        has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_select,
        has_table_privilege('authenticated', c.oid, 'INSERT') as authenticated_insert,
        has_table_privilege('authenticated', c.oid, 'UPDATE') as authenticated_update,
        has_table_privilege('authenticated', c.oid, 'DELETE') as authenticated_delete,
        has_table_privilege('service_role', c.oid, 'SELECT') as service_role_select,
        has_table_privilege('service_role', c.oid, 'INSERT') as service_role_insert,
        has_table_privilege('service_role', c.oid, 'UPDATE') as service_role_update,
        has_table_privilege('service_role', c.oid, 'DELETE') as service_role_delete
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_roles o on o.oid = c.relowner
      where n.nspname = any($1::text[])
        and c.relkind = 'r'
      order by n.nspname, c.relname
    `,
    [schemas],
  );

  return rows.map((t) => ({
    key: `${t.schema_name}.${t.table_name}`,
    schema: t.schema_name,
    name: t.table_name,
    owner: t.owner,
    rlsEnabled: t.rls_enabled,
    rlsForced: t.rls_forced,
    anonSelect: t.anon_select,
    anonInsert: t.anon_insert,
    anonUpdate: t.anon_update,
    anonDelete: t.anon_delete,
    authenticatedSelect: t.authenticated_select,
    authenticatedInsert: t.authenticated_insert,
    authenticatedUpdate: t.authenticated_update,
    authenticatedDelete: t.authenticated_delete,
    serviceRoleSelect: t.service_role_select,
    serviceRoleInsert: t.service_role_insert,
    serviceRoleUpdate: t.service_role_update,
    serviceRoleDelete: t.service_role_delete,
  }));
}

export async function collectDefaultAcl(client, schemas = BASELINE_SCHEMAS) {
  const { rows } = await client.query(
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
    [schemas],
  );

  return rows.map((d) => ({
    creatorRole: d.creator_role,
    schema: d.schema_name,
    objectType: d.object_type,
    aclSorted: d.acl_sorted,
  }));
}

export async function collectRoleMemberships(client) {
  const { rows } = await client.query(`
    select m.rolname as member_role, o.rolname as of_role
    from pg_auth_members am
    join pg_roles m on m.oid = am.member
    join pg_roles o on o.oid = am.roleid
    where m.rolname in ('anon', 'authenticated', 'service_role', 'postgres')
       or o.rolname in ('anon', 'authenticated', 'service_role', 'postgres')
    order by of_role, member_role
  `);

  return rows.map((m) => ({ member: m.member_role, of: m.of_role }));
}

// Snapshot complet, structure identique à celle écrite dans acl-baseline.json —
// c'est ce qui permet à la sonde de production de comparer terme à terme sans
// transformation supplémentaire.
export async function collectAclSnapshot(client, schemas = BASELINE_SCHEMAS) {
  // Séquentiel, PAS Promise.all : un client `pg` unique ne pipeline pas les
  // requêtes concurrentes (une seule connexion physique) — les lancer en
  // parallèle sur le même client produit un comportement non spécifié côté
  // driver. Le coût de la sérialisation est négligeable (4 requêtes courtes).
  const functions = await collectFunctions(client, schemas);
  const tables = await collectTables(client, schemas);
  const defaultAcl = await collectDefaultAcl(client, schemas);
  const roleMemberships = await collectRoleMemberships(client);

  return {
    exposedSchemas: [...EXPOSED_SCHEMAS].sort(),
    baselineSchemas: [...schemas].sort(),
    knownAnonExecuteExceptions: [...KNOWN_ANON_EXECUTE_EXCEPTIONS],
    functions,
    tables,
    defaultAcl,
    roleMemberships,
  };
}

// Version applicable-en-production de la sonde : `ci_schema_auditor` n'a de
// grant que sur `supabase_migrations.schema_migrations` (Lot 4B) — jamais sur
// une table applicative. Cette requête est la SEULE que la sonde production
// exécute en dehors des catalogues système.
export async function collectAppliedMigrationVersion(client) {
  const { rows } = await client.query(
    'select version from supabase_migrations.schema_migrations order by version desc limit 1',
  );
  if (rows.length === 0) {
    throw new Error(
      'supabase_migrations.schema_migrations est vide — aucune migration appliquée, état inattendu.',
    );
  }
  return rows[0].version;
}
