#!/usr/bin/env node
// Phase 2 / Lot S4 — Splinter, exécuté par requête directe (pas de CLI officielle).
// Recoupement partiel avec la Couche 1 (tests/rls/function-execute-acl-invariant.rls.test.ts
// pour 0028 côté anon) et avec la Tâche 3 de ce lot (0029 côté authenticated,
// tests/rls/security-definer-authenticated-whitelist.rls.test.ts) — voir
// docs/security/s4-rapport.md pour le détail de ce qui se recouvre.
//
// Ces vues filtrent 0028/0029 sur current_setting('pgrst.db_schemas', true),
// qui retombe sur 'public' seul si la GUC n'est pas positionnée (mesuré NULL
// sur stack locale, 2026-09-04) — graphql_public n'est alors pas couvert par
// CES deux règles précises (sans conséquence connue : aucune fonction
// SECURITY DEFINER n'y est recensée par l'énumération S4). 0011 n'a pas cette
// restriction — il balaie tous les schémas hors la liste d'exclusion interne
// (extensions internes Supabase), 'private' inclus.
//
// 0028/0029 amont NE FILTRENT PAS les fonctions à retour `trigger` — or
// tests/rls/function-execute-acl-invariant.rls.test.ts (Couche 1, déjà en
// production) a établi PAR MESURE DIRECTE (pas supposé) qu'une fonction
// `RETURNS trigger` est structurellement non invocable via PostgREST/RPC
// direct quelle que soit son ACL (`ERROR: trigger functions can only be
// called as triggers`, reproduit en direct). Ce script réapplique cette même
// exclusion, déjà prouvée, aux résultats de 0028/0029 — jamais au SQL
// vendorisé lui-même, qui reste intact. Mesuré sur ce dépôt (2026-09-04) :
// 18 lignes 0028 + 18 lignes 0029 exclues ainsi, toutes des triggers
// d'intégrité (assert_*_integrity). 0011 (search_path) N'EST PAS filtré de
// la même façon : un trigger reste invoqué avec un search_path mutable
// exploitable via l'opération qui le déclenche (INSERT/UPDATE), le risque
// qu'il détecte reste réel pour un trigger.
//
// 0029, une fois les triggers exclus, retombe exactement sur les 39 routines
// SECURITY DEFINER×authenticated de l'énumération S4 — c'est le recoupement
// attendu, pas une divergence : ces 39 sont DÉJÀ inscrites, nommées et
// suivies (couvertes ou legacy-uncovered datées) dans
// supabase/security/definer-authenticated-whitelist.json (Tâche 3). Les
// traiter ici comme un ÉCHEC Splinter en plus d'un échec de l'assertion de
// catalogue rendrait ce check perpétuellement rouge sans rien détecter de
// nouveau — Splinter devient alors une SECONDE source indépendante (SQL
// différent, requête différente) confirmant qu'aucune routine n'échappe à la
// liste blanche, pas un doublon de la même alerte. Seule une routine ABSENTE
// de la liste blanche est un échec Splinter réel — et elle ferait alors
// échouer aussi l'assertion de catalogue (Tâche 3), défense en profondeur
// prouvée, pas dupliquée. Même logique pour 0028 contre la liste blanche
// existante (ANON_EXECUTE_WHITELIST, tests/rls/function-execute-acl-invariant.rls.test.ts).
//
// 0011 a trouvé 4 fonctions réelles avec search_path mutable
// (get_dashboard_kpi, customer_reliability_decay_{epoch,anchor,factor}) —
// hors périmètre de la classe de défaut visée par ce lot (identifiant client
// jamais confronté au parent), donc PAS corrigées ici (consigne explicite du
// lot : remonter, jamais corriger). Admises dans
// supabase/security/search-path-mutable-admitted.json avec date et dette
// nommée — même ratchet que la liste blanche de la Tâche 3, décidé par le
// même arbitrage (admettre l'historique, bloquer toute nouveauté). Détail
// dans docs/security/s4-rapport.md.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { assertPostgresTarget } from '../lib/security/supabase-target-policy.ts';

const TRIGGER_EXCLUDED_RULES = new Set([
  '0028_anon_security_definer_function_executable',
  '0029_authenticated_security_definer_function_executable',
]);

// Même liste que tests/rls/function-execute-acl-invariant.rls.test.ts
// (ANON_EXECUTE_WHITELIST) — dupliquée volontairement (TS vs script Node pur),
// même motif que SERVICE_ROLE_ONLY_NAMES dans acl-production-probe.mjs.
const ANON_WHITELIST_KEYS = new Set([
  'graphql_public.graphql("operationName" text, query text, variables jsonb, extensions jsonb)',
]);

const AUTHENTICATED_WHITELIST_PATH = resolve(
  import.meta.dirname,
  '../supabase/security/definer-authenticated-whitelist.json',
);

function loadAuthenticatedWhitelistKeys() {
  const entries = JSON.parse(readFileSync(AUTHENTICATED_WHITELIST_PATH, 'utf8'));
  return new Set(entries.map((e) => `${e.schema}.${e.name}(${e.argsSignature})`));
}

const SEARCH_PATH_ADMITTED_PATH = resolve(
  import.meta.dirname,
  '../supabase/security/search-path-mutable-admitted.json',
);

function loadSearchPathAdmittedKeys() {
  const entries = JSON.parse(readFileSync(SEARCH_PATH_ADMITTED_PATH, 'utf8'));
  for (const e of entries) {
    if (!e.loggedAt || !/^\d{4}-\d{2}-\d{2}$/.test(e.loggedAt)) {
      throw new Error(`search-path-mutable-admitted.json : ${e.name} sans loggedAt valide`);
    }
    if (!e.debt || e.debt.trim().length === 0) {
      throw new Error(`search-path-mutable-admitted.json : ${e.name} sans debt`);
    }
  }
  return new Set(entries.map((e) => `${e.schema}.${e.name}`));
}

async function isTriggerFunction(client, schema, name) {
  const { rows } = await client.query(
    `select t.typname = 'trigger' as is_trigger
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     join pg_type t on t.oid = p.prorettype
     where n.nspname = $1 and p.proname = $2
     limit 1`,
    [schema, name],
  );
  return rows[0]?.is_trigger === true;
}

const SPLINTER_DIR = resolve(import.meta.dirname, '../supabase/security/splinter');
const dbUrl =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

assertPostgresTarget({ target: dbUrl, variableName: 'SUPABASE_DB_URL' });
const client = new pg.Client({ connectionString: dbUrl, connectionTimeoutMillis: 10_000 });
await client.connect();

const authenticatedWhitelistKeys = loadAuthenticatedWhitelistKeys();
const searchPathAdmittedKeys = loadSearchPathAdmittedKeys();

function functionKey(metadata) {
  return `${metadata.schema}.${metadata.name}(${metadata.arguments ?? ''})`;
}

let failed = false;
try {
  await client.query('create schema if not exists lint;');

  const files = readdirSync(SPLINTER_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = readFileSync(resolve(SPLINTER_DIR, file), 'utf8');
    await client.query(sql); // crée (ou remplace) la vue
  }

  for (const file of files) {
    const viewId = file.replace(/\.sql$/, '');
    const { rows: allRows } = await client.query(`select * from lint.${JSON.stringify(viewId)};`);

    let rows = allRows;
    let triggerExcludedCount = 0;
    let whitelistExcludedCount = 0;

    if (TRIGGER_EXCLUDED_RULES.has(viewId)) {
      const afterTrigger = [];
      for (const r of allRows) {
        const schema = r.metadata?.schema;
        const name = r.metadata?.name;
        if (schema && name && (await isTriggerFunction(client, schema, name))) {
          triggerExcludedCount += 1;
        } else {
          afterTrigger.push(r);
        }
      }
      rows = afterTrigger;
    }

    if (viewId === '0028_anon_security_definer_function_executable') {
      rows = rows.filter((r) => {
        const known = ANON_WHITELIST_KEYS.has(functionKey(r.metadata));
        if (known) whitelistExcludedCount += 1;
        return !known;
      });
    }
    if (viewId === '0029_authenticated_security_definer_function_executable') {
      rows = rows.filter((r) => {
        const known = authenticatedWhitelistKeys.has(functionKey(r.metadata));
        if (known) whitelistExcludedCount += 1;
        return !known;
      });
    }
    if (viewId === '0011_function_search_path_mutable') {
      rows = rows.filter((r) => {
        const key = `${r.metadata.schema}.${r.metadata.name}`;
        const admitted = searchPathAdmittedKeys.has(key);
        if (admitted) whitelistExcludedCount += 1;
        return !admitted;
      });
    }

    if (triggerExcludedCount > 0) {
      process.stdout.write(
        `Splinter ${file} — ${triggerExcludedCount} ligne(s) exclue(s) (fonctions RETURNS trigger, non invocables directement — cf. en-tête).\n`,
      );
    }
    if (whitelistExcludedCount > 0) {
      process.stdout.write(
        `Splinter ${file} — ${whitelistExcludedCount} ligne(s) déjà inscrite(s)/admise(s) et datée(s) (confirmation, pas un échec — cf. en-tête).\n`,
      );
    }

    if (rows.length > 0) {
      failed = true;
      process.stderr.write(`Splinter ${file} — ${rows.length} violation(s) NON inscrite(s) :\n`);
      for (const r of rows) process.stderr.write(`  ${JSON.stringify(r)}\n`);
    } else {
      process.stdout.write(`Splinter ${file} — OK.\n`);
    }
  }
} finally {
  await client.query('drop schema if exists lint cascade;');
  await client.end();
}

process.exit(failed ? 1 : 0);
