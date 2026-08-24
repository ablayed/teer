#!/usr/bin/env node
// Phase 2 / Lot 4B — sonde ACL PRODUCTION récurrente.
//
// Détecte la classe de dérive de l'incident 0141 (GRANT manuel appliqué en
// production hors migration, jamais committé, invisible à tout `db reset
// --local`) : le seul moyen est une mesure directe de l'ACL réelle EN
// PRODUCTION, jamais un rejeu local. Voir CLAUDE.md, section "Lot 4B", et
// supabase/security/ci-schema-auditor.sql pour le rôle utilisé.
//
// Connexion : CI_SCHEMA_AUDITOR_DB_URL (obligatoire). Le garde s'exécute AVANT
// toute tentative de connexion — jamais un saut silencieux.
//
// Étapes :
//   1. Connexion sous ci_schema_auditor (aucun privilège au-delà des grants du
//      Lot 4B — voir ci-schema-auditor.sql).
//   2. Invariant absolu (indépendant de toute version) : aucune fonction exposée
//      exécutable par anon hors liste blanche ; fonctions service_role-only
//      jamais exécutables par authenticated.
//   3. Lecture de la dernière migration réellement appliquée
//      (`supabase_migrations.schema_migrations`) — le seul GRANT au-delà des
//      catalogues système que porte ce rôle.
//   4. Mesure LIVE complète de l'ACL (mêmes requêtes que la baseline locale).
//   5. Génération d'une baseline versionnée LOCALE, arrêtée à la version lue en
//      (3), via scripts/acl-baseline-at-version.sh — jamais un instantané
//      committé (cf. justification dans ce script).
//   6. Classification à trois catégories (scripts/lib/acl-classify.mjs) contre
//      la baseline versionnée ET contre la baseline courante du dépôt.
//
// AUCUNE FUITE DE SECRET : ce script ne loggue jamais `CI_SCHEMA_AUDITOR_DB_URL`
// ni aucune chaîne de connexion. Toute erreur pg est reformulée avant d'être
// affichée (voir `safeErrorMessage`).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { checkAbsoluteInvariant, classifyAclSnapshot } from './lib/acl-classify.mjs';
import { collectAclSnapshot, collectAppliedMigrationVersion } from './lib/acl-snapshot.mjs';

const { Client } = pg;

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const CURRENT_BASELINE_PATH = resolve(PROJECT_ROOT, 'supabase/security/acl-baseline.json');

// Même liste que tests/rls/function-execute-acl-invariant.rls.test.ts
// (AUTHENTICATED_FORBIDDEN) — dupliquée volontairement plutôt que fusionnée en
// un import partagé : le test vit dans tests/rls (TypeScript, vitest) et ce
// script dans scripts/ (Node pur, exécuté hors du harnais vitest en production).
// Une divergence future entre les deux listes serait un signal à traiter, pas un
// risque silencieux : la revue de toute migration touchant ces fonctions doit
// mettre à jour les DEUX.
const SERVICE_ROLE_ONLY_NAMES = [
  'get_finance_collected_joins',
  'get_finance_returned_joins',
  'purge_pcd_access_controls',
  'rebuild_product_stock',
  'reconcile_product_stock',
  'reconcile_order_cod_status',
];

function safeErrorMessage(error) {
  // pg peut inclure la chaîne de connexion dans certains messages d'erreur
  // (échec DNS, timeout) — ne jamais la relayer telle quelle.
  const raw = String(error?.message ?? error);
  return raw.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[connection string redacted]');
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(
      `acl-production-probe: variable d'environnement manquante : ${name}. Le contrôle échoue explicitement avant toute tentative de connexion — jamais un saut silencieux.\n`,
    );
    process.exit(1);
  }
  return value;
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function runBaselineAtVersion(version, outputPath) {
  const result = spawnSync('bash', ['scripts/acl-baseline-at-version.sh', version, outputPath], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(
      `échec de la génération de la baseline versionnée (version ${version}) — voir la sortie ci-dessus.`,
    );
  }
}

async function main() {
  const dbUrl = requireEnv('CI_SCHEMA_AUDITOR_DB_URL');

  if (!existsSync(CURRENT_BASELINE_PATH)) {
    process.stderr.write(
      `acl-production-probe: baseline courante introuvable (${CURRENT_BASELINE_PATH}). Ce fichier doit être committé — voir pnpm security:acl-baseline:generate.\n`,
    );
    process.exit(1);
  }

  const client = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 15_000 });

  let snapshot;
  let appliedVersion;
  try {
    await client.connect();
    appliedVersion = await collectAppliedMigrationVersion(client);
    snapshot = await collectAclSnapshot(client);
  } catch (error) {
    process.stderr.write(
      `acl-production-probe: échec de lecture en production — ${safeErrorMessage(error)}\n`,
    );
    process.exitCode = 1;
    return;
  } finally {
    await client.end().catch(() => {});
  }

  process.stdout.write(
    `acl-production-probe: dernière migration appliquée en production = ${appliedVersion}\n`,
  );
  process.stdout.write(
    `acl-production-probe: inventaire live — ${snapshot.functions.length} fonctions, ${snapshot.tables.length} tables.\n`,
  );

  // Invariant absolu — indépendant de toute version.
  const invariantViolations = checkAbsoluteInvariant({
    functions: snapshot.functions,
    knownAnonExecuteExceptions: snapshot.knownAnonExecuteExceptions,
    serviceRoleOnlyNames: SERVICE_ROLE_ONLY_NAMES,
  });
  if (invariantViolations.length > 0) {
    process.stderr.write('acl-production-probe: INVARIANT ABSOLU VIOLÉ EN PRODUCTION :\n');
    for (const v of invariantViolations) {
      process.stderr.write(`  [${v.category}] ${v.key} — ${v.detail}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write('acl-production-probe: invariant absolu — OK.\n');

  // Baseline versionnée, jetable, jamais committée.
  const versionedBaselinePath = resolve(
    process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? '/tmp',
    `acl-baseline-${appliedVersion}.json`,
  );
  runBaselineAtVersion(appliedVersion, versionedBaselinePath);
  const versionedBaseline = loadJson(versionedBaselinePath);
  const currentBaseline = loadJson(CURRENT_BASELINE_PATH);

  let result;
  try {
    result = classifyAclSnapshot({
      production: snapshot,
      versionedBaseline,
      currentBaseline,
    });
  } catch (error) {
    process.stderr.write(`acl-production-probe: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (result.pendingDeploy.length > 0) {
    process.stdout.write(
      `acl-production-probe: ${result.pendingDeploy.length} objet(s) en attente de déploiement (non bloquant) :\n`,
    );
    for (const p of result.pendingDeploy) {
      process.stdout.write(`  [${p.objectType}] ${p.key} — ${p.detail}\n`);
    }
  } else {
    process.stdout.write('acl-production-probe: aucun objet en attente de déploiement.\n');
  }

  if (result.failures.length > 0) {
    process.stderr.write(`acl-production-probe: ${result.failures.length} ÉCHEC(S) :\n`);
    for (const f of result.failures) {
      process.stderr.write(`  [${f.category}] (${f.objectType}) ${f.key} — ${f.detail ?? ''}\n`);
      if (f.diffs) {
        for (const d of f.diffs) {
          process.stderr.write(
            `      champ ${d.field} : production=${JSON.stringify(d.production)} attendu(baseline version ${appliedVersion})=${JSON.stringify(d.expected)}\n`,
          );
        }
      }
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    'acl-production-probe: PASS — production conforme à la baseline de sa version.\n',
  );
}

main().catch((error) => {
  process.stderr.write(`acl-production-probe: échec inattendu — ${safeErrorMessage(error)}\n`);
  process.exit(1);
});
