/**
 * Phase F — Lot U1-F, garde de classe (pas d'instance) sur le bug trouvé pendant ce lot :
 * `GainLoss`/`ValueAmount` utilisaient `text-warning-foreground` (#111111, prévu pour du texte
 * SUR un fond `bg-warning`) comme couleur de texte autonome — quasi indiscernable de l'encre
 * normale (`--text: #111111`). Le nommage `*-foreground` est un piège générique : rien n'empêche
 * la même confusion de revenir au prochain composant. Ce test l'attrape structurellement,
 * n'importe où dans `components/ui/`, pas seulement dans les deux fichiers déjà corrigés.
 *
 * Un token `--color-X-foreground` (défini dans app/globals.css) n'a de sens QUE couplé à
 * `bg-X` dans la même chaîne de classes — jamais comme couleur de texte autonome. Les tokens
 * réels sont extraits de app/globals.css (pas codés en dur) : au 2026-08-27, seuls `warning` et
 * `info` ont un compagnon `-foreground`. `muted-foreground`/`background` (vus dans
 * textarea.tsx/drawer.tsx) sont un vestige shadcn sans variable CSS Tëër derrière — hors
 * périmètre de cette règle, qui ne porte que sur la convention réellement définie.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type Violation = { token: string; snippet: string };

function realForegroundTokenNames(globalsCssSource: string): string[] {
  const names = new Set<string>();
  for (const match of globalsCssSource.matchAll(/--color-([a-z-]+)-foreground:/g)) {
    names.add(match[1]);
  }
  return [...names];
}

/** Pure — testable sans lire le disque, cf. contrôles positif/négatif ci-dessous. */
function findForegroundTokenMisuse(source: string, foregroundTokenNames: string[]): Violation[] {
  const violations: Violation[] = [];

  for (const quoted of source.matchAll(/['"`]([^'"`]*)['"`]/g)) {
    const classString = quoted[1];
    for (const name of foregroundTokenNames) {
      const tokenPattern = new RegExp(`\\btext-${name}-foreground\\b`);
      if (tokenPattern.test(classString) && !classString.includes(`bg-${name}`)) {
        violations.push({ token: `text-${name}-foreground`, snippet: classString });
      }
    }
  }

  return violations;
}

const globalsCss = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8');
const foregroundTokenNames = realForegroundTokenNames(globalsCss);

describe('findForegroundTokenMisuse (vérification du détecteur lui-même)', () => {
  it('signale un token -foreground utilisé sans son fond apparié (reproduit le bug trouvé)', () => {
    const violations = findForegroundTokenMisuse(
      "className={cn('inline-flex items-baseline gap-1.5 text-warning-foreground', className)}",
      ['warning'],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].token).toBe('text-warning-foreground');
  });

  it('ne signale rien quand le fond apparié est présent (contrôle positif)', () => {
    const violations = findForegroundTokenMisuse(
      "className: 'bg-warning/15 text-warning-foreground'",
      ['warning'],
    );
    expect(violations).toHaveLength(0);
  });

  it('ne signale rien pour un texte sans token -foreground', () => {
    const violations = findForegroundTokenMisuse("className: 'text-warning text-sm font-medium'", [
      'warning',
    ]);
    expect(violations).toHaveLength(0);
  });
});

describe('components/ui/**/*.tsx — aucun token -foreground utilisé hors de son fond', () => {
  it('app/globals.css définit au moins un token -foreground réel (warning, info)', () => {
    expect(foregroundTokenNames.length).toBeGreaterThan(0);
    expect(foregroundTokenNames).toContain('warning');
  });

  it('aucun fichier de components/ui ne réutilise le piège text-warning-foreground/text-info-foreground', () => {
    const dir = join(process.cwd(), 'components', 'ui');
    const files = readdirSync(dir).filter((f) => f.endsWith('.tsx'));

    const allViolations: Array<Violation & { file: string }> = [];
    for (const file of files) {
      const source = readFileSync(join(dir, file), 'utf8');
      for (const violation of findForegroundTokenMisuse(source, foregroundTokenNames)) {
        allViolations.push({ ...violation, file });
      }
    }

    expect(allViolations).toEqual([]);
  });
});
