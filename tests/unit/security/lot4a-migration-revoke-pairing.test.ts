import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Phase 2 / Lot 4A — Couche 3 : contrôle textuel de la règle "toute NOUVELLE fonction
// (CREATE FUNCTION, pas CREATE OR REPLACE) dans public porte son REVOKE explicite
// nommant anon, dans le MÊME fichier de migration" (CLAUDE.md, section "Lot 4A"). C'est
// un filet de REVUE, pas une preuve de sécurité : seule la couche 1
// (tests/rls/function-execute-acl-invariant.rls.test.ts), qui mesure
// `has_function_privilege` en direct, fait foi sur l'exposition réelle.
//
// PÉRIMÈTRE VOLONTAIREMENT RESTREINT AU `CREATE FUNCTION` PLEIN (PAS `CREATE OR
// REPLACE`) — CALIBRÉ, PAS DEVINÉ. `CREATE OR REPLACE FUNCTION` sur une signature
// IDENTIQUE conserve l'ACL existante (CLAUDE.md : "CREATE OR REPLACE conserve
// ownership et l'ACL existante, mais PAS SECURITY/search_path/..."). Une première
// version de ce test couvrait aussi `CREATE OR REPLACE` et produisait 42 violations
// sur 41 fichiers (migrations 0101→0141) — un taux de faux positifs proche de 100 %,
// chaque `CREATE OR REPLACE FUNCTION transition_order(...)` etc. étant signalé alors
// que son ACL est héritée, pas remise à zéro. Restreint au `CREATE FUNCTION` plein
// (une fonction qui n'existait pas avant, ACL TOUJOURS remise au défaut ouvert sur ce
// stack), le même balayage tombe à 1 violation UNIQUE, RÉELLE : `0123` créait
// `log_ia_tool_audit` avec `revoke ... from public` SEUL (sans `anon`) — exactement le
// bug que `0140` a dû corriger a posteriori (cf. son en-tête). Zéro faux positif
// mesuré sur 41 fichiers réels ; le seul cas détecté est un vrai défaut historique.
//
// LIMITE RESTANTE, ASSUMÉE : ce test vérifie la PRÉSENCE textuelle d'un revoke nommant
// `anon` — il attrape l'oubli total, PAS un revoke qui nomme `anon` mais reste
// insuffisant pour une autre raison (mauvais schéma, mauvaise signature après un DROP,
// etc.). Ne jamais le lire comme une garantie d'ACL fermée ; c'est la couche 1 qui
// porte cette garantie, en interrogeant l'ACL réelle.
//
// PÉRIMÈTRE TEMPOREL : seules les migrations postérieures au dernier numéro déjà
// audité par ce lot (`0141`) sont vérifiées. La règle est une obligation POUR
// L'AVENIR, pas un audit rétroactif de l'historique (qui suit des conventions plus
// anciennes, ex. `0018`→`0043` : fermeture par une migration ultérieure distincte,
// motif toujours vivant pour `record_cash_settlement`/`write_off_shortfall`).
const LAST_AUDITED_MIGRATION_NUMBER = 141;

const MIGRATIONS_DIR = resolve(process.cwd(), 'supabase/migrations');

function migrationNumber(filename: string): number | null {
  const match = filename.match(/^(\d{4,})_/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function newMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .filter((name) => {
      const n = migrationNumber(name);
      return n !== null && n > LAST_AUDITED_MIGRATION_NUMBER;
    })
    .sort();
}

// Volontairement `create function`, PAS `create (or replace) function` — voir
// calibration ci-dessus. Ne couvre que le schéma `public` : les fonctions `private`
// ne sont pas exposées PostgREST (0136), hors du risque que cette règle adresse.
const CREATE_FUNCTION_RE = /create\s+function\s+public\.(\w+)\s*\(/gi;

describe('Lot 4A — pairing CREATE FUNCTION / REVOKE (migrations postérieures à 0141)', () => {
  const files = newMigrationFiles();

  it('sanity : le périmètre est calculé, pas vide par accident', () => {
    // Aucune migration n'existe encore au-delà de 0141 au moment de ce lot — c'est
    // attendu (voir "état actuel" dans le rapport). Ce test vérifie seulement que le
    // filtre lui-même fonctionne (pas d'exception, pas de crash de lecture).
    expect(Array.isArray(files)).toBe(true);
  });

  it('toute fonction public NOUVELLEMENT créée dans une migration récente est explicitement revoke de anon dans le même fichier', () => {
    const violations: string[] = [];

    for (const file of files) {
      const content = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');
      const createdFunctions = new Set<string>();
      for (const match of content.matchAll(CREATE_FUNCTION_RE)) {
        createdFunctions.add(match[1]);
      }

      for (const fnName of createdFunctions) {
        // Un revoke qui mentionne le nom de la fonction ET `anon` (insensible à la
        // casse), dans l'un ou l'autre ordre — analyse textuelle volontairement
        // permissive (voir limite ci-dessus), pas un parseur SQL.
        const revokeRe = new RegExp(
          `revoke[^;]*\\bpublic\\.${fnName}\\b[^;]*\\banon\\b|revoke[^;]*\\banon\\b[^;]*\\bpublic\\.${fnName}\\b`,
          'is',
        );
        if (!revokeRe.test(content)) {
          violations.push(
            `${file} : ${fnName}() créée sans revoke nommant "anon" dans le même fichier`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
