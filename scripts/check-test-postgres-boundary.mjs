#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const TESTS_ROOT = resolve(ROOT, 'tests');
const HELPER = resolve(TESTS_ROOT, 'helpers/postgres-client.ts');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js']);

function collectFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(path);
    return SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf('.'))) ? [path] : [];
  });
}

// Couvre les formes effectivement admises : import statique (nomme ou aliase),
// require() et import dynamique, toutes avec le specifieur literal `pg`.
const PG_IMPORT = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()(['"])pg\1/g;
const violations = [];

for (const file of collectFiles(TESTS_ROOT)) {
  if (file === HELPER) continue;
  const source = readFileSync(file, 'utf8');
  if (PG_IMPORT.test(source)) {
    violations.push(relative(ROOT, file).replaceAll('\\', '/'));
  }
  PG_IMPORT.lastIndex = 0;
}

if (violations.length > 0) {
  process.stderr.write('test-postgres-boundary: ECHEC\n');
  for (const file of violations) {
    process.stderr.write(
      `  import de pg interdit hors tests/helpers/postgres-client.ts : ${file}\n`,
    );
  }
  process.exit(1);
}

process.stdout.write('test-postgres-boundary: OK\n');
