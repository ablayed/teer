import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkAbsoluteInvariant,
  classifyAclObjects,
  classifyAclSnapshot,
} from '../../../scripts/lib/acl-classify.mjs';

// Phase 2 / Lot 4B — preuves LOCALES des cinq cas d'échec exigés par le lot.
// Les cas 1 et 2 (secret absent / connexion refusée) sont prouvés en faisant
// tourner le VRAI script scripts/acl-production-probe.mjs en sous-processus,
// jamais contre la production — voir CLAUDE.md, "Preuves exigées". Les cas 3,
// 4 et 5 sont prouvés en pur (scripts/lib/acl-classify.mjs), sans base de
// données, mockant les trois inventaires (production / baseline versionnée /
// baseline courante).

const PROJECT_ROOT = resolve(import.meta.dirname, '../../..');
const PROBE_SCRIPT = resolve(PROJECT_ROOT, 'scripts/acl-production-probe.mjs');

function fn(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    key: 'public.my_function()',
    schema: 'public',
    name: 'my_function',
    args: '',
    returnType: 'void',
    securityDefiner: false,
    volatility: 'volatile',
    parallelSafety: 'unsafe',
    owner: 'postgres',
    searchPathConfig: '',
    aclIsDefault: false,
    proaclSorted: 'authenticated=X/postgres',
    anonExec: false,
    authenticatedExec: true,
    serviceRoleExec: true,
    ...overrides,
  };
}

describe('Lot 4B — cas 1 : secret CI_SCHEMA_AUDITOR_DB_URL absent', () => {
  it('échoue explicitement, en nommant la variable, AVANT toute tentative de connexion', () => {
    const env = { ...process.env };
    env.CI_SCHEMA_AUDITOR_DB_URL = undefined;

    const start = Date.now();
    const result = spawnSync('node', [PROBE_SCRIPT], {
      cwd: PROJECT_ROOT,
      env,
      encoding: 'utf8',
      timeout: 10_000,
    });
    const elapsedMs = Date.now() - start;

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CI_SCHEMA_AUDITOR_DB_URL');
    // Doit échouer quasi instantanément — la preuve que le garde s'exécute
    // avant toute tentative réseau (un vrai essai de connexion timeoutrait à
    // 15s, cf. connectionTimeoutMillis dans acl-production-probe.mjs).
    expect(elapsedMs).toBeLessThan(3_000);
  });
});

describe('Lot 4B — cas 2 : secret invalide, connexion refusée (cible locale contrôlée, jamais la production)', () => {
  it('échoue proprement et ne fuite jamais la chaîne de connexion dans les logs', () => {
    // Port fermé garanti sur loopback — jamais un hôte de production.
    const env = {
      ...process.env,
      CI_SCHEMA_AUDITOR_DB_URL:
        'postgresql://ci_schema_auditor:wrong-secret-value@127.0.0.1:1/postgres',
    };

    const result = spawnSync('node', [PROBE_SCRIPT], {
      cwd: PROJECT_ROOT,
      env,
      encoding: 'utf8',
      timeout: 20_000,
    });

    expect(result.status).toBe(1);
    const combined = `${result.stdout}${result.stderr}`;
    expect(combined).not.toContain('wrong-secret-value');
    expect(combined).not.toContain('ci_schema_auditor:wrong-secret-value');
  });
});

describe('Lot 4B — cas 3 : inventaire de production vide', () => {
  it('refuse un inventaire à 0 fonction ET 0 table — jamais un succès silencieux', () => {
    expect(() =>
      classifyAclSnapshot({
        production: { functions: [], tables: [] },
        versionedBaseline: { functions: [], tables: [] },
        currentBaseline: { functions: [], tables: [] },
      }),
    ).toThrow(/Inventaire de production vide/);
  });

  it('ne lève PAS si au moins fonctions OU tables est non vide', () => {
    expect(() =>
      classifyAclSnapshot({
        production: { functions: [fn()], tables: [] },
        versionedBaseline: { functions: [fn()], tables: [] },
        currentBaseline: { functions: [fn()], tables: [] },
      }),
    ).not.toThrow();
  });
});

describe('Lot 4B — cas 4 : objet en production, absent de la baseline de sa version (forme de l’incident 0141)', () => {
  it('échoue en catégorie unexplained_production_object', () => {
    const manualGrantFn = fn({
      key: 'public.reconcile_product_stock()',
      name: 'reconcile_product_stock',
    });

    const { failures } = classifyAclObjects({
      productionObjects: [manualGrantFn],
      versionedBaselineObjects: [], // absente de la baseline de la version déployée
      currentBaselineObjects: [manualGrantFn],
      objectLabel: 'function',
    });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      category: 'unexplained_production_object',
      key: 'public.reconcile_product_stock()',
    });
  });

  it('rouge puis vert : restaurer l’entrée dans la baseline versionnée fait disparaître l’échec', () => {
    const object = fn({ key: 'public.some_fn()' });

    const red = classifyAclObjects({
      productionObjects: [object],
      versionedBaselineObjects: [],
      currentBaselineObjects: [object],
      objectLabel: 'function',
    });
    expect(red.failures).toHaveLength(1);

    const green = classifyAclObjects({
      productionObjects: [object],
      versionedBaselineObjects: [object],
      currentBaselineObjects: [object],
      objectLabel: 'function',
    });
    expect(green.failures).toHaveLength(0);
  });
});

describe('Lot 4B — cas 5 : ACL divergente à version égale', () => {
  it('échoue en catégorie acl_drift_at_matched_version avec le champ divergent nommé', () => {
    const production = fn({ authenticatedExec: true });
    const expectedAtVersion = fn({ authenticatedExec: false });

    const { failures } = classifyAclObjects({
      productionObjects: [production],
      versionedBaselineObjects: [expectedAtVersion],
      currentBaselineObjects: [production],
      objectLabel: 'function',
    });

    expect(failures).toHaveLength(1);
    expect(failures[0].category).toBe('acl_drift_at_matched_version');
    expect(failures[0].diffs).toEqual([
      { field: 'authenticatedExec', production: true, expected: false },
    ]);
  });

  it('rouge puis vert : aligner l’ACL fait disparaître l’échec', () => {
    const divergent = fn({ authenticatedExec: true });
    const baseline = fn({ authenticatedExec: false });

    const red = classifyAclObjects({
      productionObjects: [divergent],
      versionedBaselineObjects: [baseline],
      currentBaselineObjects: [divergent],
      objectLabel: 'function',
    });
    expect(red.failures).toHaveLength(1);

    const aligned = fn({ authenticatedExec: false });
    const green = classifyAclObjects({
      productionObjects: [aligned],
      versionedBaselineObjects: [baseline],
      currentBaselineObjects: [aligned],
      objectLabel: 'function',
    });
    expect(green.failures).toHaveLength(0);
  });
});

describe('Lot 4B — borne de la catégorie 2 (retard de déploiement non bloquant)', () => {
  it('rapporte non-bloquant un objet absent en production ET absent de la baseline de sa version (0142)', () => {
    const pendingObject = fn({ key: 'public.store_connection', name: 'store_connection' });

    const { failures, pendingDeploy } = classifyAclObjects({
      productionObjects: [],
      versionedBaselineObjects: [], // absent aussi à la version déployée : explique le retard
      currentBaselineObjects: [pendingObject],
      objectLabel: 'table',
    });

    expect(failures).toHaveLength(0);
    expect(pendingDeploy).toHaveLength(1);
    expect(pendingDeploy[0].key).toBe('public.store_connection');
  });

  it("échoue si un objet manquant en production N'EST PAS expliqué par une migration non déployée", () => {
    const shouldExistObject = fn({ key: 'public.orders', name: 'orders' });

    const { failures, pendingDeploy } = classifyAclObjects({
      productionObjects: [],
      versionedBaselineObjects: [shouldExistObject], // présent à la version déployée : rien ne l'explique
      currentBaselineObjects: [shouldExistObject],
      objectLabel: 'table',
    });

    expect(pendingDeploy).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0].category).toBe('missing_in_production_unexplained');
  });
});

describe('Lot 4B — invariant absolu (rejoué en production, indépendant de la version)', () => {
  it('signale une fonction exposée exécutable par anon hors liste blanche', () => {
    const leaking = fn({
      key: 'public.leaky()',
      name: 'leaky',
      anonExec: true,
      returnType: 'void',
    });
    const violations = checkAbsoluteInvariant({
      functions: [leaking],
      knownAnonExecuteExceptions: [],
      serviceRoleOnlyNames: [],
    });
    expect(violations).toEqual([
      { category: 'anon_executable', key: 'public.leaky()', detail: expect.any(String) },
    ]);
  });

  it('ignore les fonctions trigger même si anon_exec=true (comportement moteur, pas une garde)', () => {
    const trigger = fn({
      key: 'public.set_updated_at()',
      name: 'set_updated_at',
      anonExec: true,
      returnType: 'trigger',
    });
    const violations = checkAbsoluteInvariant({
      functions: [trigger],
      knownAnonExecuteExceptions: [],
      serviceRoleOnlyNames: [],
    });
    expect(violations).toEqual([]);
  });

  it('signale une fonction service_role-only exécutable par authenticated', () => {
    const leaking = fn({
      key: 'public.reconcile_product_stock()',
      name: 'reconcile_product_stock',
      authenticatedExec: true,
    });
    const violations = checkAbsoluteInvariant({
      functions: [leaking],
      knownAnonExecuteExceptions: [],
      serviceRoleOnlyNames: ['reconcile_product_stock'],
    });
    expect(violations).toContainEqual(
      expect.objectContaining({ category: 'service_role_only_executable_by_authenticated' }),
    );
  });
});
