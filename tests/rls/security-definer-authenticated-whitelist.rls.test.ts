import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertPostgresTarget } from '@/lib/security/supabase-target-policy';
import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { EXPOSED_SCHEMAS, collectFunctions } from '../../scripts/lib/acl-snapshot.mjs';

// Lot S4 — Couche 1 étendue : toute routine SECURITY DEFINER exécutable par
// `authenticated` doit figurer dans une liste blanche versionnée, portant son
// identité complète, sa nature, et un test de frontière — ou, à défaut d'une
// telle preuve aujourd'hui, un statut `legacy-uncovered` DATÉ et justifié par
// une dette nommée (arbitrage du porteur, 2026-09-04 : ratchet — voir
// docs/security/s4-enumeration-definer-authenticated.md). Ce test ne prouve
// PAS que les 32 entrées `legacy-uncovered` sont sûres — il prouve seulement
// qu'aucune NOUVELLE routine ne peut apparaître sans être inscrite ici, et
// que le statut `legacy-uncovered` reste honnête (daté, motivé), jamais un
// trou silencieux permanent.

const dbUrl =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const hasEnv = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);

const WHITELIST_PATH = resolve(
  process.cwd(),
  'supabase/security/definer-authenticated-whitelist.json',
);

type WhitelistEntry = {
  schema: string;
  name: string;
  argsSignature: string;
  role: string;
  nature: 'read' | 'write';
  status: 'covered' | 'legacy-uncovered';
  test?: string;
  loggedAt?: string;
  debt?: string;
};

function loadWhitelist(): WhitelistEntry[] {
  const raw = JSON.parse(readFileSync(WHITELIST_PATH, 'utf8'));
  expect(Array.isArray(raw)).toBe(true);
  expect(raw.length).toBeGreaterThan(0);
  return raw;
}

let pg: Client | undefined;

afterAll(async () => {
  await pg?.end();
});

describe.skipIf(!hasEnv)('Lot S4 — routines SECURITY DEFINER exécutables par authenticated', () => {
  it('chaque entrée "covered" référence un test réel qui existe sur le disque', () => {
    const whitelist = loadWhitelist();
    for (const entry of whitelist.filter((w) => w.status === 'covered')) {
      expect(entry.test, `${entry.name} : status covered sans champ test`).toBeTruthy();
      expect(() => readFileSync(resolve(process.cwd(), entry.test as string))).not.toThrow();
    }
  });

  it('chaque entrée "legacy-uncovered" porte une date et une dette nommée — jamais un trou silencieux', () => {
    const whitelist = loadWhitelist();
    const violations: string[] = [];
    for (const entry of whitelist.filter((w) => w.status === 'legacy-uncovered')) {
      if (!entry.loggedAt || !/^\d{4}-\d{2}-\d{2}$/.test(entry.loggedAt)) {
        violations.push(`${entry.name} : loggedAt manquant ou mal formé`);
      }
      if (!entry.debt || entry.debt.trim().length === 0) {
        violations.push(`${entry.name} : debt manquant`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('toute routine SECURITY DEFINER exécutable par authenticated figure dans la liste blanche', async () => {
    assertPostgresTarget({ target: dbUrl, variableName: 'SUPABASE_DB_URL' });
    pg = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 10_000 });
    await pg.connect();
    const functions = await collectFunctions(pg, EXPOSED_SCHEMAS);
    expect(functions.length).toBeGreaterThan(0);

    const whitelist = loadWhitelist();
    const whitelisted = new Set(whitelist.map((w) => `${w.schema}.${w.name}(${w.argsSignature})`));

    const violations = functions
      .filter((f) => f.securityDefiner && f.authenticatedExec && f.returnType !== 'trigger')
      .map((f) => f.key)
      .filter((key) => !whitelisted.has(key));

    expect(violations).toEqual([]);
  });

  it('toute routine SECURITY DEFINER de la liste blanche porte un search_path explicite dans proconfig', async () => {
    assertPostgresTarget({ target: dbUrl, variableName: 'SUPABASE_DB_URL' });
    pg = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 10_000 });
    await pg.connect();
    const functions = await collectFunctions(pg, EXPOSED_SCHEMAS);
    const byKey = new Map(functions.map((f) => [f.key, f]));

    const whitelist = loadWhitelist();
    const violations: string[] = [];
    for (const entry of whitelist) {
      const key = `${entry.schema}.${entry.name}(${entry.argsSignature})`;
      const fn = byKey.get(key);
      if (!fn) {
        violations.push(`${key} : introuvable (renommée/supprimée depuis l'inscription ?)`);
        continue;
      }
      if (!fn.searchPathConfig || !fn.searchPathConfig.includes('search_path')) {
        violations.push(`${key} : proconfig sans search_path explicite`);
      }
    }
    expect(violations).toEqual([]);
  });
});
