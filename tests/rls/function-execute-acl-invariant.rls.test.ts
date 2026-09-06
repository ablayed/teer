import { assertPostgresTarget } from '@/lib/security/supabase-target-policy';
import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

// Phase 2 / Lot 4A — Couche 1 : assertion invariante sur l'ACL EXECUTE réelle des
// fonctions, jamais un instantané régénérable.
//
// CONTEXTE (voir CLAUDE.md, section "Lot 4A — détection de l'exposition ACL") :
// un diagnostic exhaustif (six reproductions convergentes, dont une session psql
// native dans le conteneur, éliminant tout artefact d'outillage) a établi que
// `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` NE FERME
// PAS l'ACL des fonctions créées ensuite sur ce stack Supabase — `pg_default_acl`
// reflète fidèlement la demande pendant que la fonction créée après naît quand
// même exécutable par `anon`. Le mécanisme exact est NON ÉTABLI (aucune extension
// nommée dans ce commentaire, volontairement) ; l'écart, lui, est mesuré. En
// conséquence, ce projet n'a JAMAIS pu compter sur un défaut de schéma fermé —
// seul un `revoke`/`grant` EXPLICITE, posé sur l'objet après sa création (le
// motif que suivent déjà `0043`, `0067`, `0114`, `0140`, `0141`), ferme
// réellement l'accès. Ce test mesure l'effet réel de ce motif — jamais sa
// présence textuelle dans le SQL (piège documenté : `revoke ... from public`
// sans nommer `anon` est un no-op sur Supabase, cf. CLAUDE.md).
//
// PROPRIÉTÉ VÉRIFIÉE, PAS UN INSTANTANÉ : aucune fonction des schémas exposés à
// PostgREST (`supabase/config.toml:6`, `api.schemas`) n'est exécutable par `anon`,
// sauf la liste blanche nommée ci-dessous. Devant un rouge, le geste ne peut PAS
// être « régénérer » — il n'y a rien à régénérer. Le test reste rouge jusqu'à ce
// que la fonction fautive soit réellement fermée par un `revoke` explicite.
//
// Mesure exclusivement via `has_function_privilege` (jamais la lecture de
// `proacl` seule : `proacl IS NULL` signifie « défaut », et le défaut ici est
// ouvert — c'est précisément le mécanisme qui a produit l'incident 0134/0135 et
// la fuite `reconcile_product_stock` de la clôture Phase 1, cf. `0141`).

// Doit rester synchronisé avec `supabase/config.toml:6` (`api.schemas`). Un écart
// entre les deux est un problème de couverture de ce test, pas une raison de le
// désynchroniser silencieusement — vérifié en revue, pas en CI (le fichier TOML
// n'est pas reparsé ici pour garder ce test lisible en une seule assertion).
const EXPOSED_SCHEMAS = ['public', 'graphql_public'];

// Liste blanche NOMMÉE, volontairement statique — l'ajout d'une entrée doit être
// un acte délibéré, visible en revue de code, avec la justification en commentaire.
// Clé : `schema.nom(pg_get_function_identity_arguments)`.
const ANON_EXECUTE_WHITELIST = new Set<string>([
  // Entrée pg_graphql installée par Supabase (event trigger `grant_pg_graphql_access`,
  // hors du contrôle de ce dépôt). Seule fonction du projet réellement exécutable par
  // `anon` par conception — cf. CLAUDE.md, audit Phase 1/2A.
  'graphql_public.graphql("operationName" text, query text, variables jsonb, extensions jsonb)',
]);

// Fonctions confirmées `service_role`-only par lecture directe des migrations
// (0087, 0124, 0141, 0144) — jamais de grant `authenticated`. Une régression ici
// rouvrirait des chemins financiers/maintenance à toute session utilisateur normale.
const AUTHENTICATED_FORBIDDEN = new Set<string>([
  'get_finance_collected_joins',
  'get_finance_returned_joins',
  'purge_pcd_access_controls',
  'rebuild_product_stock',
  'reconcile_product_stock',
  'reconcile_order_cod_status',
  // 0144 — garde d'idempotence refund + écritures métier atomiques. Appelée
  // exclusivement par le client service-role du Route Handler webhook ; aucune
  // session authenticated ne doit jamais pouvoir écrire orders/audit_log par ce
  // chemin (contournerait toutes les gardes RBAC applicatives).
  'record_shopify_refund_receipt',
]);

const dbUrl =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const hasEnv = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);

type FnRow = {
  schema_name: string;
  func_name: string;
  args: string;
  return_type: string;
  anon_exec: boolean;
  authenticated_exec: boolean;
  service_role_exec: boolean;
};

let pg: Client | undefined;
let rows: FnRow[] = [];

async function loadRows(): Promise<FnRow[]> {
  if (rows.length > 0) return rows;
  assertPostgresTarget({ target: dbUrl, variableName: 'SUPABASE_DB_URL' });
  pg = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 10_000 });
  await pg.connect();
  const { rows: r } = await pg.query<FnRow>(
    `
      select
        n.nspname as schema_name,
        p.proname as func_name,
        pg_get_function_identity_arguments(p.oid) as args,
        t.typname as return_type,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_exec,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_exec
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_type t on t.oid = p.prorettype
      where n.nspname = any($1::text[])
      order by n.nspname, p.proname, args
    `,
    [EXPOSED_SCHEMAS],
  );
  rows = r;
  return rows;
}

afterAll(async () => {
  await pg?.end();
});

describe.skipIf(!hasEnv)('Couche 1 — invariant ACL EXECUTE (anon / authenticated)', () => {
  it("aucune fonction exposée PostgREST n'est exécutable par anon, hors liste blanche", async () => {
    const functions = await loadRows();

    // Garde-fou anti-faux-vert : si la découverte de fonctions s'effondre (mauvais
    // schéma, connexion vide), ce test ne doit pas passer silencieusement.
    expect(functions.length).toBeGreaterThan(50);

    // Les fonctions de retour `trigger` sont exclues, PROUVÉ et pas supposé : PostgreSQL
    // refuse structurellement leur invocation directe, quelle que soit l'ACL —
    // `ERROR: trigger functions can only be called as triggers` (reproduit en direct,
    // `set role anon; select public.set_updated_at();`, sur ce stack). PostgREST ne les
    // expose jamais non plus comme endpoint RPC. `has_function_privilege` renvoie `true`
    // pour elles (c'est le comportement PAR DÉFAUT de la plateforme sur ce type de
    // fonction, non corrigible par un `revoke` — vérifier ne changerait rien à
    // l'exploitabilité réelle, qui est nulle par construction du moteur). Les inclure
    // produirait un bruit permanent sans jamais signaler un risque réel.
    const violations = functions
      .filter((f) => f.anon_exec && f.return_type !== 'trigger')
      .map((f) => `${f.schema_name}.${f.func_name}(${f.args})`)
      .filter((key) => !ANON_EXECUTE_WHITELIST.has(key));

    expect(violations).toEqual([]);
  });

  it('les fonctions service_role-only ne sont jamais exécutables par authenticated', async () => {
    const functions = await loadRows();

    const byName = new Map<string, FnRow[]>();
    for (const f of functions) {
      const list = byName.get(f.func_name) ?? [];
      list.push(f);
      byName.set(f.func_name, list);
    }

    const violations: string[] = [];
    for (const name of AUTHENTICATED_FORBIDDEN) {
      const matches = byName.get(name);
      if (!matches || matches.length === 0) {
        violations.push(`${name} : introuvable dans les schémas exposés (renommée/supprimée ?)`);
        continue;
      }
      // Une fonction service_role-only qui se retrouve surchargée (2 signatures) doit
      // être re-vérifiée manuellement : cette liste ne couvre pas silencieusement une
      // nouvelle signature.
      if (matches.length > 1) {
        violations.push(
          `${name} : ${matches.length} signatures trouvées, vérifier chacune manuellement`,
        );
      }
      for (const m of matches) {
        if (m.authenticated_exec) {
          violations.push(`${m.schema_name}.${m.func_name}(${m.args}) : authenticated_exec=true`);
        }
        if (!m.service_role_exec) {
          violations.push(
            `${m.schema_name}.${m.func_name}(${m.args}) : service_role_exec=false (fonction inatteignable par son appelant réel)`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
