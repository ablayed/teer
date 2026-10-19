import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type TestPostgresClient, createTestPostgresClient } from '../helpers/postgres-client';

// Lot D — jumeau, pour les TABLES, VUES et SÉQUENCES, de l'invariant EXECUTE des fonctions
// (function-execute-acl-invariant.rls.test.ts). Il mesure l'effet RÉEL (`has_table_privilege`,
// `has_sequence_privilege`), jamais la présence d'un `revoke` dans le SQL.
//
// PROPRIÉTÉ : l'ensemble des relations de `public` où `anon` détient un droit est INCLUS dans la
// liste gelée `supabase/security/anon-privilege-allowlist.json`. Cette liste ne peut que rétrécir
// (lot A du plan de droits explicites). Une NOUVELLE relation qui naît avec les droits par défaut de
// l'image — `anon` y a `arwdDxtm` aujourd'hui — fait rougir ce test, même si quelqu'un régénère la
// baseline ACL pour le faire taire : la baseline est un instantané, cette liste est une barrière.
//
// POURQUOI MAINTENANT : à partir du 30/10, Supabase n'accorde plus ces droits aux nouveaux objets. Une
// migration qui s'appuyait sur le défaut passerait en local et casserait en production ; celle qui
// pose ses droits explicitement fonctionne dans les deux régimes.

const dbUrl =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const hasEnv = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);

type Allowlist = { schema: string; tables: string[]; views: string[]; sequences: string[] };
const allowlist = JSON.parse(
  readFileSync(resolve(process.cwd(), 'supabase/security/anon-privilege-allowlist.json'), 'utf8'),
) as Allowlist;

const ALLOWED = new Set<string>([
  ...allowlist.tables.map((n) => `r:${allowlist.schema}.${n}`),
  ...allowlist.views.map((n) => `v:${allowlist.schema}.${n}`),
  ...allowlist.sequences.map((n) => `S:${allowlist.schema}.${n}`),
]);

type Row = { relkind: string; schema_name: string; name: string; anon_privilege: boolean };

let pg: TestPostgresClient | undefined;

afterAll(async () => {
  await pg?.end();
});

describe.skipIf(!hasEnv)('Lot D — invariant : droits d’anon sur les relations de public', () => {
  it('aucune relation neuve n’est accessible à anon : l’ensemble reste inclus dans la liste gelée', async () => {
    pg = createTestPostgresClient(dbUrl, 'SUPABASE_DB_URL', { connectionTimeoutMillis: 10_000 });
    await pg.connect();
    const { rows } = await pg.query<Row>(
      `
        select
          c.relkind::text as relkind,
          n.nspname as schema_name,
          c.relname as name,
          case
            when c.relkind = 'S' then has_sequence_privilege('anon', c.oid, 'USAGE,SELECT,UPDATE')
            else has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          end as anon_privilege
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1
          and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
        order by c.relkind, c.relname
      `,
      [allowlist.schema],
    );

    // Anti-faux-vert : si la découverte s'effondre (mauvais schéma, connexion vide), le test ne
    // doit pas passer en silence.
    expect(rows.length).toBeGreaterThan(50);

    const withPrivilege = rows.filter((r) => r.anon_privilege);
    const violations = withPrivilege
      .map((r) => {
        const kind = r.relkind === 'p' ? 'r' : r.relkind === 'm' ? 'v' : r.relkind;
        return {
          key: `${kind}:${r.schema_name}.${r.name}`,
          label: `${r.schema_name}.${r.name} (${r.relkind})`,
        };
      })
      .filter(({ key }) => !ALLOWED.has(key))
      .map(({ label }) => label);

    // Un rouge ne se corrige PAS en ajoutant le nom à la liste : on ferme la relation par un
    // REVOKE explicite nommant anon dans sa migration (convention : docs/security/convention-droits-explicites.md).
    expect(violations).toEqual([]);
  });

  it('la liste gelée ne contient que des relations qui existent encore (pas d’entrée fantôme)', async () => {
    const present = new Set<string>();
    const client = createTestPostgresClient(dbUrl, 'SUPABASE_DB_URL', {
      connectionTimeoutMillis: 10_000,
    });
    await client.connect();
    try {
      const { rows } = await client.query<{ relkind: string; name: string }>(
        `select c.relkind::text as relkind, c.relname as name
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')`,
        [allowlist.schema],
      );
      for (const r of rows) {
        const kind = r.relkind === 'p' ? 'r' : r.relkind === 'm' ? 'v' : r.relkind;
        present.add(`${kind}:${allowlist.schema}.${r.name}`);
      }
    } finally {
      await client.end();
    }

    // Une relation supprimée ou renommée doit sortir de la liste : elle ne doit pas servir de
    // passe-droit à un futur homonyme.
    const ghosts = [...ALLOWED].filter((key) => !present.has(key));
    expect(ghosts).toEqual([]);
  });
});
