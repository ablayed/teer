#!/usr/bin/env node
// Phase 2 / Lot S4 — inventaire justifié des références à SUPABASE_SERVICE_ROLE_KEY.
// Suit le motif de scripts/s1d4-check-client-bundle.mjs : recherche textuelle
// simple, pas une règle Biome — un import direct du module qui construit le
// client service-role n'existe pas dans ce dépôt (chaque site le construit
// localement, cf. docs/security/s4-etape0-mesures.md) ; la référence textuelle
// à la variable d'environnement est donc le signal disponible.
//
// Chaque entrée cite un fichier + une ligne réelle pour la nature de frontière
// que CE fichier porte réellement (rôle applicatif, HMAC, secret cron,
// résolution de jeton) — ou `boundaryType: "NONE"` explicite, jamais un "N/A"
// vague. Ce script vérifie que la ligne citée existe encore et n'est pas vide
// (garde-fou contre une citation périmée après un futur refactor), pas que la
// garde elle-même est correcte — c'est un filet d'inventaire, pas une preuve
// de sécurité (la preuve vient des tests de frontière, Tâche 4).
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const INVENTORY_PATH = resolve(ROOT, 'supabase/security/service-role-inventory.json');

const found = execSync(`grep -rl "SUPABASE_SERVICE_ROLE_KEY" lib app --include='*.ts'`, {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)
  .map((f) => f.replace(/\\/g, '/'))
  .sort();

const inventory = JSON.parse(readFileSync(INVENTORY_PATH, 'utf8'));
const inventoried = new Set(inventory.map((e) => e.file));

const problems = [];

for (const f of found) {
  if (!inventoried.has(f)) problems.push(`non inventorié : ${f}`);
}

for (const e of inventory) {
  if (!existsSync(resolve(ROOT, e.file)) || !found.includes(e.file)) {
    problems.push(`entrée obsolète (fichier absent ou ne référence plus la clé) : ${e.file}`);
    continue;
  }
  if (!e.boundaryType) {
    problems.push(`${e.file} : boundaryType manquant`);
    continue;
  }
  if (e.boundaryType !== 'NONE') {
    if (!e.boundaryFile || !existsSync(resolve(ROOT, e.boundaryFile))) {
      problems.push(`${e.file} : boundaryFile introuvable (${e.boundaryFile})`);
      continue;
    }
    const lines = readFileSync(resolve(ROOT, e.boundaryFile), 'utf8').split('\n');
    const line = lines[e.boundaryLine - 1] ?? '';
    if (line.trim().length === 0) {
      problems.push(
        `${e.file} : boundaryLine ${e.boundaryLine} est vide dans ${e.boundaryFile} — citation périmée`,
      );
    }
  }
  if (!e.boundaryDetail || e.boundaryDetail.trim().length === 0) {
    problems.push(`${e.file} : boundaryDetail manquant`);
  }
}

if (problems.length > 0) {
  process.stderr.write('service-role-inventory: ÉCHEC\n');
  for (const p of problems) process.stderr.write(`  ${p}\n`);
  process.exit(1);
}

process.stdout.write(
  `service-role-inventory: OK — ${inventory.length} fichier(s) inventorié(s).\n`,
);
