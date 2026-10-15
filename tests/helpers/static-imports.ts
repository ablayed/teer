import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

// Fichiers atteignables par imports STATIQUES (alias `@/`) : les `import()` dynamiques et les imports
// de type (`import type`, `import { type X }` seuls) ne comptent pas. C'est ce que le navigateur
// reçoit AVANT toute interaction. Lecture de l'arbre syntaxique, sans exécuter le code.

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

export function staticReachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of source.statements) {
      let specifier: string | null = null;
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        const typeOnly =
          clause?.isTypeOnly === true ||
          (clause !== undefined &&
            clause.name === undefined &&
            clause.namedBindings !== undefined &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((element) => element.isTypeOnly));
        if (!typeOnly && ts.isStringLiteral(statement.moduleSpecifier)) {
          specifier = statement.moduleSpecifier.text;
        }
      } else if (
        ts.isExportDeclaration(statement) &&
        !statement.isTypeOnly &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        specifier = statement.moduleSpecifier.text;
      }
      const resolved = specifier ? resolveImport(file, specifier) : null;
      if (resolved) stack.push(resolved);
    }
  }
  return seen;
}
