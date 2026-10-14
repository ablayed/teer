import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

// Graphe d'imports du dépôt (alias `@/`), pour les gardes qui raisonnent sur « ce qu'une route
// embarque » : lecture statique des `import … from` et `import(…)`, sans exécuter le code. C'est une
// borne SUPÉRIEURE : un fichier importé seulement pour un type, ou jamais rendu, compte quand même.

const ROOT = resolve(import.meta.dirname, '../..');
const EXTENSIONS = ['.tsx', '.ts', '/index.tsx', '/index.ts'];

export function repoRoot(): string {
  return ROOT;
}

function resolveImport(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = join(ROOT, specifier.slice(2));
  else if (specifier.startsWith('.')) base = resolve(dirname(from), specifier);
  else return null;
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const extension of EXTENSIONS) {
    const candidate = base + extension;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const info = ts.preProcessFile(text, true, true);
  return info.importedFiles
    .map((entry) => resolveImport(file, entry.fileName))
    .filter((resolved): resolved is string => resolved !== null);
}

/** Tous les fichiers atteignables depuis `entry` (lui compris). */
export function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const next of importsOf(file)) stack.push(next);
  }
  return seen;
}

/** Les espaces de noms passés littéralement à `useTranslations('…')` dans un fichier. */
export function translationNamespacesIn(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/useTranslations\(\s*(?:'([^']*)'|"([^"]*)")\s*\)/g)].map(
    (match) => match[1] ?? match[2] ?? '',
  );
}

/** Appels `useTranslations()` sans espace de noms littéral : la garde ne peut pas les couvrir. */
export function hasNonLiteralTranslations(file: string): boolean {
  const text = readFileSync(file, 'utf8');
  const all = [...text.matchAll(/useTranslations\(([^)]*)\)/g)].map((m) => (m[1] ?? '').trim());
  return all.some((arg) => !/^(?:'[^']*'|"[^"]*")$/.test(arg));
}
