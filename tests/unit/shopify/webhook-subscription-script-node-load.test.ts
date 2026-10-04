// SHOPIFY-WEBHOOKS-PER-SHOP-1B / C7, W12 — le script de diagnostic se charge sous le NODE NATIF,
// et il ne reste aucun rafraîchissement de jeton hors de lib/shopify/oauth.ts et token.ts.
//
// Couche : unitaire, mais le chargement est RÉEL : un processus `node` distinct, sans vitest.
// Vitest résout l'alias `@/` ; le Node natif, non. Un import d'alias en valeur sur le chemin du
// script (régression introduite par un lot précédent, dans lib/shopify/oauth.ts) passait donc
// tous les tests tout en rendant le script inutilisable. Seul un vrai processus Node le voit.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SCRIPT = 'scripts/webhook-subscription-migration.mjs';

// Environnement réduit au strict nécessaire : aucune variable du projet n'est transmise, et
// surtout pas NODE_ENV=test, qui court-circuiterait le chemin réel du script.
function runNode(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
    } as unknown as NodeJS.ProcessEnv,
    timeout: 60_000,
  });
}

describe('chargement réel sous Node natif', () => {
  it('`node scripts/webhook-subscription-migration.mjs --help` sort en 0', () => {
    const result = runNode(['--help']);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--plan --shop-domain');
    // Aucune erreur de résolution de module : tout le graphe d'imports s'est chargé.
    expect(result.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find (module|package)/);
  }, 90_000);

  it('`--apply` et `--rotate-token` sont retirés : refus nommé, sortie non nulle', () => {
    for (const flag of ['--apply', '--rotate-token']) {
      const result = runNode([flag, '--shop-domain', 'pilot.myshopify.com']);
      expect(result.status, flag).toBe(1);
      // Le refus NOMMÉ, et non le simple rappel d'usage (qui mentionne aussi leur retrait).
      expect(result.stderr).toContain('ce script ne fait plus que --plan');
    }
  }, 90_000);

  it('sans mode : usage, sortie non nulle, aucune action', () => {
    const result = runNode([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--plan --shop-domain');
  }, 90_000);
});

// Suit les imports RELATIFS du script, comme le fait Node, et rend tous les fichiers atteints.
function nodeImportGraph(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [join(ROOT, entry)];
  const importPattern = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g;
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      if (specifier.startsWith('.')) {
        queue.push(join(file, '..', specifier));
      }
    }
  }
  return [...seen];
}

describe('chemin Node du script — aucun alias en valeur', () => {
  const files = nodeImportGraph(SCRIPT);

  it('atteint le script, son module de plan et les modules lib qu’il charge', () => {
    const reached = files.map((file) => relative(ROOT, file).split(sep).join('/'));
    expect(reached).toEqual(
      expect.arrayContaining([
        SCRIPT,
        'scripts/lib/webhook-subscription-plan.mjs',
        'lib/shopify/webhook-subscription-inventory.ts',
        'lib/shopify/webhook-subscription-topics.ts',
        'lib/ingestion/webhook-token.ts',
        'lib/shopify/graphql.ts',
        'lib/shopify/crypto.ts',
      ]),
    );
  });

  it('ne contient aucun import d’alias `@/` qui survive à l’effacement des types', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(
        /^\s*(import|export)\s+(?!type\s)[^;]*?from\s+['"]@\/[^'"]+['"]/gm,
      )) {
        offenders.push(`${relative(ROOT, file)} : ${match[0].trim().slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('ne charge ni lib/shopify/oauth.ts ni lib/shopify/token.ts : le diagnostic ne rafraîchit rien', () => {
    const reached = files.map((file) => relative(ROOT, file).split(sep).join('/'));
    expect(reached).not.toContain('lib/shopify/oauth.ts');
    expect(reached).not.toContain('lib/shopify/token.ts');
  });
});

function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, directory))) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(directory, entry);
    if (statSync(join(ROOT, path)).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (/\.(ts|tsx|mjs|js)$/.test(entry)) {
      out.push(path.split(sep).join('/'));
    }
  }
  return out;
}

describe('recherche finale — le rafraîchissement n’existe que dans oauth.ts et token.ts', () => {
  const ALLOWED = new Set(['lib/shopify/oauth.ts', 'lib/shopify/token.ts']);
  const files = ['app', 'lib', 'scripts', 'components'].flatMap(sourceFiles);

  it('aucun `grant_type: refresh_token` ailleurs', () => {
    const hits = files.filter(
      (file) =>
        !ALLOWED.has(file) &&
        /grant_type['"]?\s*[:=]\s*['"]refresh_token['"]/.test(
          readFileSync(join(ROOT, file), 'utf8'),
        ),
    );
    expect(hits).toEqual([]);
  });

  it('aucun appel ni import de `refreshAccessToken` ailleurs', () => {
    const hits = files.filter(
      (file) =>
        !ALLOWED.has(file) && /\brefreshAccessToken\b/.test(readFileSync(join(ROOT, file), 'utf8')),
    );
    expect(hits).toEqual([]);
  });

  it('contrôle positif : la recherche trouve bien les deux fichiers autorisés', () => {
    const found = files.filter((file) =>
      /\brefreshAccessToken\b/.test(readFileSync(join(ROOT, file), 'utf8')),
    );
    expect(found.sort()).toEqual([...ALLOWED].sort());
  });

  it('les scripts d’opérateur qui tournaient le jeton L3 hors bail ont disparu', () => {
    const scripts = sourceFiles('scripts');
    expect(scripts).not.toContain('scripts/l3-generate-webhook-token.mjs');
    expect(scripts).not.toContain('scripts/lib/webhook-token-provisioning.mjs');
  });
});
