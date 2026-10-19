import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeMigration, createdNames } from '../../helpers/migration-grants';

// Lot D — droits explicites pour tout objet NOUVEAU (table, vue, séquence, fonction). Voir
// tests/helpers/migration-grants.ts pour le POURQUOI (changement Supabase du 30/10) et
// docs/security/convention-droits-explicites.md pour le modèle SQL à copier.
//
// Ce test est un filet de REVUE (présence textuelle). L'effet réel est mesuré par
// tests/rls/anon-privilege-frozen-allowlist.rls.test.ts (tables, vues, séquences) et
// tests/rls/function-execute-acl-invariant.rls.test.ts (fonctions).

// Première migration soumise à la règle. 0168 est réservée au lot « Montants A2 » : elle y sera
// soumise si elle crée un objet. Les migrations antérieures suivent des conventions plus
// anciennes (calibrage ci-dessous : 51 objets neufs depuis 0142, zéro violation).
const FIRST_GUARDED_MIGRATION_NUMBER = 168;

const MIGRATIONS_DIR = resolve(process.cwd(), 'supabase/migrations');
const ALLOWLIST_FILE = resolve(process.cwd(), 'supabase/security/anon-privilege-allowlist.json');

function migrationFiles(): Array<{ name: string; number: number; sql: string }> {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      number: Number.parseInt(name.slice(0, 4), 10),
      sql: readFileSync(resolve(MIGRATIONS_DIR, name), 'utf8'),
    }));
}

const rules = (sql: string, known: string[] = []) =>
  analyzeMigration(sql, new Set(known)).violations.map((v) => `${v.rule} ${v.object}`);

describe('Lot D — l’analyseur applique la règle (cas synthétiques)', () => {
  const COMPLIANT_TABLE = `
    create table public.exemple (id uuid primary key);
    alter table public.exemple enable row level security;
    revoke all on table public.exemple from public, anon, authenticated, service_role;
    grant select, insert on table public.exemple to authenticated;
    grant select, insert, update, delete on table public.exemple to service_role;
  `;

  it('une table fermée puis ouverte au strict nécessaire est conforme', () => {
    expect(rules(COMPLIANT_TABLE)).toEqual([]);
  });

  it('R1 — une table sans REVOKE nommant anon est signalée', () => {
    const sql = COMPLIANT_TABLE.replace(/revoke all[^;]*;/, '');
    expect(rules(sql)).toEqual(['R1-revoke-anon public.exemple']);
  });

  it('R1 — « revoke … from public » seul ne ferme rien sur Supabase', () => {
    const sql = COMPLIANT_TABLE.replace(
      'from public, anon, authenticated, service_role',
      'from public',
    );
    expect(rules(sql)).toEqual(['R1-revoke-anon public.exemple']);
  });

  it('R2 — une table fermée mais sans aucun GRANT explicite est signalée', () => {
    const sql = `
      create table public.sans_grant (id int);
      revoke all on table public.sans_grant from public, anon, authenticated, service_role;
    `;
    expect(rules(sql)).toEqual(['R2-grant-explicite public.sans_grant']);
  });

  it('R2 — un objet sans droit VOLONTAIRE se déclare par un marqueur qui le nomme', () => {
    const sql = `
      -- droits-explicites: aucun public.verrou_interne
      create table public.verrou_interne (id int);
      revoke all on table public.verrou_interne from public, anon, authenticated, service_role;
    `;
    expect(rules(sql)).toEqual([]);
    // Le marqueur ne dispense PAS de fermer anon.
    expect(rules(sql.replace(/revoke all[^;]*;/, ''))).toEqual([
      'R1-revoke-anon public.verrou_interne',
    ]);
    // Un marqueur qui nomme un autre objet ne couvre pas celui-ci.
    expect(rules(sql.replace('public.verrou_interne\n', 'public.autre\n'))).toContain(
      'R2-grant-explicite public.verrou_interne',
    );
  });

  it('R2 — « grant all tables in schema » n’est pas un droit explicite sur l’objet', () => {
    const sql = `
      create table public.fourre_tout (id int);
      revoke all on table public.fourre_tout from public, anon, authenticated, service_role;
      grant select on all tables in schema public to service_role;
    `;
    expect(rules(sql)).toEqual(['R2-grant-explicite public.fourre_tout']);
  });

  it('R3 — aucun GRANT à anon ni à public, même sur un objet conforme par ailleurs', () => {
    expect(rules(`${COMPLIANT_TABLE} grant select on table public.exemple to anon;`)).toEqual([
      'R3-grant-anon public.exemple',
    ]);
    expect(rules(`${COMPLIANT_TABLE} grant select on table public.exemple to public;`)).toEqual([
      'R3-grant-anon public.exemple',
    ]);
  });

  it('R5 — une vue doit être security_invoker, fermée et ouverte explicitement', () => {
    const view = (options: string) => `
      create view public.vue_exemple ${options} as select 1 as x;
      revoke all on table public.vue_exemple from public, anon, authenticated, service_role;
      grant select on table public.vue_exemple to authenticated;
    `;
    expect(rules(view('with (security_invoker = true)'))).toEqual([]);
    expect(rules(view(''))).toEqual(['R5-security-invoker public.vue_exemple']);
    expect(rules(view('with (security_barrier = true)'))).toEqual([
      'R5-security-invoker public.vue_exemple',
    ]);
  });

  it('une séquence nommée suit la même règle', () => {
    const sql = (extra: string) => `create sequence public.ma_sequence; ${extra}`;
    expect(rules(sql(''))).toEqual([
      'R1-revoke-anon public.ma_sequence',
      'R2-grant-explicite public.ma_sequence',
    ]);
    expect(
      rules(
        sql(`revoke all on sequence public.ma_sequence from public, anon, authenticated, service_role;
             grant usage on sequence public.ma_sequence to service_role;`),
      ),
    ).toEqual([]);
  });

  it('une fonction neuve exige son REVOKE nommant anon ET un EXECUTE explicite', () => {
    const fn = (extra: string) => `
      create function public.ma_fonction(p uuid) returns integer language sql as $$ select 1 $$;
      ${extra}
    `;
    expect(rules(fn(''))).toEqual([
      'R1-revoke-anon public.ma_fonction',
      'R2-grant-explicite public.ma_fonction',
    ]);
    expect(rules(fn('revoke all on function public.ma_fonction(uuid) from public;'))).toContain(
      'R1-revoke-anon public.ma_fonction',
    );
    expect(
      rules(
        fn(`revoke all on function public.ma_fonction(uuid) from public, anon, authenticated, service_role;
            grant execute on function public.ma_fonction(uuid) to authenticated;`),
      ),
    ).toEqual([]);
    expect(
      rules(
        fn(
          'revoke all on function public.ma_fonction(uuid) from public, anon; grant execute on function public.ma_fonction(uuid) to anon;',
        ),
      ),
    ).toContain('R3-grant-anon public.ma_fonction');
  });

  it('une fonction de retour trigger est exemptée, comme dans le lot 4A', () => {
    const sql =
      'create function public.set_updated_at() returns trigger language plpgsql as $$ begin return new; end $$;';
    expect(rules(sql)).toEqual([]);
  });

  it('« create or replace » d’un objet déjà connu garde son ACL : ce n’est pas un objet neuf', () => {
    const sql =
      'create or replace function public.deja_la(p int) returns int language sql as $$ select 1 $$;';
    expect(rules(sql, ['public.deja_la'])).toEqual([]);
    // …mais un « or replace » sur un nom INCONNU est bien un objet neuf.
    expect(rules(sql, [])).toEqual([
      'R1-revoke-anon public.deja_la',
      'R2-grant-explicite public.deja_la',
    ]);
  });

  it('ignore le DDL cité dans un commentaire, une chaîne ou un corps de fonction', () => {
    const sql = `
      -- create table public.fantome (id int);
      /* create table public.fantome2 (id int); */
      select 'create table public.fantome3 (id int)';
      create or replace function public.connue() returns int language plpgsql as $f$
        begin execute 'create table public.dynamique (id int)'; return 1; end
      $f$;
    `;
    expect(createdNames(sql)).toEqual(['public.connue']);
  });

  it('un schéma explicite et des guillemets désignent le même objet', () => {
    const sql = `
      create table "public"."guillemets" (id int);
      revoke all on table public.guillemets from public, anon, authenticated, service_role;
      grant select on table "public"."guillemets" to service_role;
    `;
    expect(rules(sql)).toEqual([]);
  });
});

describe('Lot D — les migrations postérieures au seuil respectent la règle', () => {
  it('chaque objet neuf des migrations gardées porte ses droits dans son propre fichier', () => {
    const known = new Set<string>();
    const violations: string[] = [];
    let guarded = 0;

    for (const file of migrationFiles()) {
      const analysis = analyzeMigration(file.sql, known);
      if (file.number >= FIRST_GUARDED_MIGRATION_NUMBER) {
        guarded += 1;
        for (const v of analysis.violations)
          violations.push(`${file.name} : ${v.rule} ${v.detail}`);
      }
      for (const created of analysis.created) known.add(created.name);
    }

    // Aujourd'hui aucune migration n'atteint le seuil : le test est vide MAIS armé (voir les cas
    // synthétiques ci-dessus et le calibrage ci-dessous). `guarded` n'est pas une assertion.
    expect(guarded).toBeGreaterThanOrEqual(0);
    expect(violations).toEqual([]);
  });
});

describe('Lot D — calibrage : l’analyseur n’est ni aveugle ni permissif', () => {
  const analyses = (() => {
    const known = new Set<string>();
    return migrationFiles().map((file) => {
      const analysis = analyzeMigration(file.sql, known);
      const fresh = analysis.created.filter((o) => !(o.orReplace && known.has(o.name)));
      for (const created of analysis.created) known.add(created.name);
      return { file, analysis, fresh };
    });
  })();

  it('signale les 26 tables qui dépendent aujourd’hui du défaut d’image', () => {
    const allowlist = JSON.parse(readFileSync(ALLOWLIST_FILE, 'utf8')) as { tables: string[] };
    const flagged = new Set<string>();
    for (const { analysis } of analyses) {
      for (const v of analysis.violations) {
        if (v.kind === 'table') flagged.add(v.object.replace(/^public\./, ''));
      }
    }
    // Un analyseur devenu permissif (regex trop large) cesserait de reconnaître ces tables.
    expect(allowlist.tables.filter((t) => !flagged.has(t))).toEqual([]);
    expect(allowlist.tables).toHaveLength(26);
  });

  it('ne signale aucun des objets créés depuis 0142 (la convention est déjà tenue de fait)', () => {
    const recent = analyses.filter(
      ({ file }) => file.number >= 142 && file.number < FIRST_GUARDED_MIGRATION_NUMBER,
    );
    const objects = recent.reduce((sum, { fresh }) => sum + fresh.length, 0);
    const violations = recent.flatMap(({ file, analysis }) =>
      analysis.violations.map((v) => `${file.name} : ${v.rule} ${v.object}`),
    );

    expect(objects).toBeGreaterThan(40);
    expect(violations).toEqual([]);
  });
});
