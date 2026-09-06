#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const APPLICATION_ROOTS = [resolve(ROOT, 'app'), resolve(ROOT, 'lib')];
const MAINTENANCE_MODULE = resolve(ROOT, 'scripts/lib/supabase-maintenance-target.mjs');
const EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js'];
const IMPORT_SPECIFIER =
  /(?:\bimport\s+(?:[^'"()]*?\s+from\s+)?|\bexport\s+(?:\*|\{[^}]*\})\s+from\s+|\brequire\s*\(|\bimport\s*\()(['"])([^'"]+)\1/g;

function collectFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(path);
    return EXTENSIONS.includes(extname(path)) ? [path] : [];
  });
}

function resolveSpecifier(from, specifier) {
  const base = specifier.startsWith('@/')
    ? resolve(ROOT, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(from), specifier)
      : undefined;
  if (!base) return undefined;
  const candidates = extname(base)
    ? [base]
    : [base, ...EXTENSIONS.map((extension) => `${base}${extension}`)];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function imports(file) {
  const source = readFileSync(file, 'utf8');
  const results = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const resolved = resolveSpecifier(file, match[2]);
    if (resolved) results.push(resolved);
  }
  return results;
}

const visited = new Set();
const violations = [];
function visit(file, ancestry) {
  const key = `${file}:${ancestry[0] ?? file}`;
  if (visited.has(key)) return;
  visited.add(key);
  for (const imported of imports(file)) {
    const nextAncestry = [...ancestry, imported];
    if (imported === MAINTENANCE_MODULE) {
      violations.push(nextAncestry);
      continue;
    }
    visit(imported, nextAncestry);
  }
}

for (const root of APPLICATION_ROOTS) {
  for (const file of collectFiles(root)) visit(file, [file]);
}

if (violations.length > 0) {
  process.stderr.write('maintenance-import-boundary: ECHEC\n');
  for (const path of violations) {
    process.stderr.write(
      `  chemin applicatif vers le canal de maintenance : ${path.map((file) => relative(ROOT, file).replaceAll('\\', '/')).join(' -> ')}\n`,
    );
  }
  process.exit(1);
}

process.stdout.write('maintenance-import-boundary: OK\n');
