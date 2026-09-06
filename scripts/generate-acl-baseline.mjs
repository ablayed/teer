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
// Lot L1 (0142) étend ce périmètre aux TABLES de base (`relkind = 'r'`) des schémas
// couverts : privilèges anon/authenticated/service_role par opération
// (`has_table_privilege`, jamais une lecture de policy), plus RLS enabled/forced et
// owner. Comme pour les fonctions, seule une mesure directe fait foi — la présence
// d'une policy ne prouve rien sans le grant de table sous-jacent (0A-bis : les
// privilèges par défaut Supabase accordent CRUD à anon/authenticated au niveau
// table ; FORCE RLS + deny-by-default est la seule barrière réelle).
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
import { assertPostgresTarget } from '../lib/security/supabase-target-policy.ts';
import { BASELINE_SCHEMAS, collectAclSnapshot } from './lib/acl-snapshot.mjs';

const { Client } = pg;

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
// Lot 4B : ACL_BASELINE_OUTPUT permet à scripts/acl-baseline-at-version.mjs de
// générer une baseline jetable (non committée, sous un chemin temporaire) sans
// dupliquer ce script. Par défaut (aucune variable posée), le comportement est
// STRICTEMENT inchangé — le chemin committé du dépôt.
const BASELINE_PATH = process.env.ACL_BASELINE_OUTPUT
  ? resolve(process.env.ACL_BASELINE_OUTPUT)
  : resolve(PROJECT_ROOT, 'supabase/security/acl-baseline.json');

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
  assertPostgresTarget({ target: dbUrl, variableName: 'SUPABASE_DB_URL' });
  const client = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 10_000 });
  await client.connect();

  try {
    // Lot 4B : requêtes extraites vers scripts/lib/acl-snapshot.mjs, réutilisées
    // à l'identique par la baseline versionnée et par la sonde de production —
    // voir ce module pour le détail des colonnes. BASELINE_SCHEMAS peut être
    // surchargé via ACL_BASELINE_SCHEMAS (CSV) pour un usage ponctuel ; par
    // défaut (aucune variable posée), inchangé.
    const schemas = process.env.ACL_BASELINE_SCHEMAS
      ? process.env.ACL_BASELINE_SCHEMAS.split(',').map((s) => s.trim())
      : BASELINE_SCHEMAS;

    const baseline = await collectAclSnapshot(client, schemas);

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
