import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pickMessages } from '@/lib/i18n/pick-messages';
import {
  hasNonLiteralTranslations,
  reachableFrom,
  repoRoot,
  translationNamespacesIn,
} from '@/tests/helpers/import-graph';
import { describe, expect, it } from 'vitest';
import messages from '../../../messages/fr.json';

// Messages par sous-arbre client (V3). Le layout de l'application livre les espaces de noms de sa
// coque ; chaque page déclare les siens (`withMessages([...], Page)`). Un espace de noms oublié
// afficherait une clé à la place d'un texte. Cette garde lit le GRAPHE D'IMPORTS de chaque page :
// tout `useTranslations('x')` atteignable doit être couvert. Le graphe est une borne supérieure
// (un import jamais rendu compte), jamais inférieure.

const ROOT = repoRoot();
const APP = join(ROOT, 'app/(app)');

function files(dir: string, names: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, names);
    return names.test(name) ? [path] : [];
  });
}

const covers = (provided: readonly string[], needed: string) =>
  provided.some((p) => needed === p || needed.startsWith(`${p}.`));

function required(entry: string): Map<string, string[]> {
  const byNamespace = new Map<string, string[]>();
  for (const file of reachableFrom(entry)) {
    for (const namespace of translationNamespacesIn(file)) {
      byNamespace.set(namespace, [...(byNamespace.get(namespace) ?? []), file.replace(ROOT, '')]);
    }
  }
  return byNamespace;
}

function literalArray(source: string, pattern: RegExp): string[] | null {
  const match = pattern.exec(source);
  if (!match) return null;
  return [...(match[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
}

const layoutSource = readFileSync(join(APP, 'layout.tsx'), 'utf8');
const shellNamespaces = literalArray(
  layoutSource,
  /pickMessages\(\s*messages as never,\s*\[([^\]]*)\]/,
);

describe('messages par sous-arbre : couverture des espaces de noms', () => {
  it('le layout déclare ses espaces de noms par un littéral', () => {
    expect(shellNamespaces).not.toBeNull();
    expect(shellNamespaces?.length).toBeGreaterThan(0);
  });

  it('aucun useTranslations sans espace de noms littéral dans les fichiers atteignables', () => {
    const offenders: string[] = [];
    const entries = [join(APP, 'layout.tsx'), ...files(APP, /^(page|layout|error|loading)\.tsx$/)];
    for (const entry of entries) {
      for (const file of reachableFrom(entry)) {
        if (hasNonLiteralTranslations(file)) offenders.push(file.replace(ROOT, ''));
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it('la coque : tout ce que le layout atteint est fourni par le layout', () => {
    const missing = [...required(join(APP, 'layout.tsx')).keys()].filter(
      (namespace) => !covers(shellNamespaces ?? [], namespace),
    );
    expect(missing).toEqual([]);
  });

  it.each(files(APP, /^(error|loading)\.tsx$/).map((file) => [file.replace(ROOT, ''), file]))(
    '%s (hors page) : couvert par le layout',
    (_label, file) => {
      const missing = [...required(file as string).keys()].filter(
        (namespace) => !covers(shellNamespaces ?? [], namespace),
      );
      expect(missing).toEqual([]);
    },
  );

  it.each(files(APP, /^page\.tsx$/).map((file) => [file.replace(ROOT, ''), file]))(
    '%s : tout ce que la page atteint est fourni par sa déclaration',
    (_label, file) => {
      const source = readFileSync(file as string, 'utf8');
      const provided = literalArray(source, /export default withMessages\(\s*\[([^\]]*)\]/);
      const needed = [...required(file as string).keys()];
      // Une page sans espace de noms à fournir peut ne rien déclarer ; elle ne doit alors rien
      // atteindre non plus.
      if (provided === null) {
        expect(needed).toEqual([]);
        return;
      }
      const missing = needed.filter((namespace) => !covers(provided, namespace));
      expect(missing).toEqual([]);
    },
  );

  it('la page qui déclare un espace de noms en a besoin (pas de message livré pour rien)', () => {
    const useless: string[] = [];
    for (const file of files(APP, /^page\.tsx$/)) {
      const provided = literalArray(
        readFileSync(file, 'utf8'),
        /export default withMessages\(\s*\[([^\]]*)\]/,
      );
      if (!provided) continue;
      const needed = [...required(file).keys()];
      for (const namespace of provided) {
        if (!needed.some((n) => n === namespace || n.startsWith(`${namespace}.`))) {
          useless.push(`${file.replace(ROOT, '')} : ${namespace}`);
        }
      }
    }
    expect(useless).toEqual([]);
  });

  it('tout espace de noms déclaré existe dans messages/fr.json', () => {
    const declared = new Set<string>(shellNamespaces ?? []);
    for (const file of files(APP, /^page\.tsx$/)) {
      for (const namespace of literalArray(
        readFileSync(file, 'utf8'),
        /export default withMessages\(\s*\[([^\]]*)\]/,
      ) ?? []) {
        declared.add(namespace);
      }
    }
    const absent = [...declared].filter((namespace) => {
      let node: unknown = messages;
      for (const key of namespace.split('.')) {
        node =
          typeof node === 'object' && node !== null
            ? (node as Record<string, unknown>)[key]
            : undefined;
      }
      return node === undefined;
    });
    expect(absent).toEqual([]);
  });
});

describe('pickMessages', () => {
  const tree = {
    a: { x: '1', y: { z: '2' } },
    b: { c: '3' },
    d: '4',
  };

  it('garde les sous-arbres demandés, imbrication conservée', () => {
    expect(pickMessages(tree, ['a.y', 'd'])).toEqual({ a: { y: { z: '2' } }, d: '4' });
  });

  it('un chemin absent est ignoré', () => {
    expect(pickMessages(tree, ['nope', 'b'])).toEqual({ b: { c: '3' } });
  });

  it('deux demandes qui se recouvrent : le plus large l’emporte', () => {
    expect(pickMessages(tree, ['a.y', 'a'])).toEqual({ a: tree.a });
    expect(pickMessages(tree, ['a', 'a.y'])).toEqual({ a: tree.a });
  });

  it('ne modifie pas l’entrée', () => {
    const copy = JSON.parse(JSON.stringify(tree));
    pickMessages(tree, ['a.y']);
    expect(tree).toEqual(copy);
  });
});
