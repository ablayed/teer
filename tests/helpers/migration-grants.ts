// Lot D — analyseur PUR des migrations : tout objet NOUVEAU (table, vue, séquence, fonction) porte
// ses droits explicitement dans le MÊME fichier. Aucune dépendance à une base : du texte SQL en
// entrée, des violations en sortie. Consommé par tests/unit/security/lot-d-explicit-grants.test.ts.
//
// POURQUOI (CLAUDE.md, « Droits explicites ») : jusqu'ici une nouvelle table naissait avec les droits
// par défaut de l'image (`anon`, `authenticated`, `service_role` : `arwdDxtm`), et seule la RLS la
// protégeait. Supabase ne les accordera plus automatiquement aux nouveaux objets à partir du 30/10 ;
// une migration qui s'appuie sur le défaut passerait en local et casserait en production. Ce garde
// force le même état, quel que soit le défaut de l'image : fermer explicitement, puis ouvrir au
// strict nécessaire.
//
// C'est un filet de REVUE (présence textuelle), pas une preuve d'ACL : l'effet réel est mesuré par
// tests/rls/anon-privilege-frozen-allowlist.rls.test.ts.

export type ObjectKind = 'table' | 'view' | 'matview' | 'sequence' | 'function';

export type CreatedObject = {
  kind: ObjectKind;
  /** `schema.nom`, schéma `public` par défaut. */
  name: string;
  orReplace: boolean;
  /** Fonction `returns trigger` : non invocable directement, exemptée comme dans le lot 4A. */
  isTrigger: boolean;
  /** Vue déclarée `security_invoker`. */
  securityInvoker: boolean;
};

export type Violation = {
  object: string;
  kind: ObjectKind | 'grant';
  rule: string;
  detail: string;
};

export type Analysis = { created: CreatedObject[]; violations: Violation[] };

const ALLOWED_GRANTEES = new Set(['authenticated', 'service_role']);

// Marqueur d'un objet qui n'a VOLONTAIREMENT aucun droit (accès réservé à postgres et aux fonctions
// SECURITY DEFINER). Doit nommer l'objet : `-- droits-explicites: aucun public.ma_table`.
const NO_GRANT_MARKER = /--\s*droits-explicites:\s*aucun\s+([\w."]+)/gi;

export function normalizeName(raw: string): string {
  const cleaned = raw.replace(/"/g, '').replace(/\s+/g, '').toLowerCase();
  return cleaned.includes('.') ? cleaned : `public.${cleaned}`;
}

// Retire commentaires, chaînes et corps entre dollars : le balayage ne voit que le DDL de premier
// niveau, jamais du SQL dynamique ni un `create table` cité dans un commentaire.
export function stripSqlNoise(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/(\$[a-z0-9_]*\$)[\s\S]*?\1/gi, '$$$$')
    .replace(/'(?:[^']|'')*'/g, "''");
}

function targetsOf(segment: string, kind: ObjectKind | 'any'): string[] {
  const body = segment
    .replace(/^\s*(table|sequence|function|procedure)\s+/i, '')
    .replace(/^\s*all\s+(tables|sequences|functions)\s+in\s+schema\s+[\w"]+/i, 'ALL_IN_SCHEMA');
  if (body === 'ALL_IN_SCHEMA') return ['*'];
  if (kind === 'function' || /\(/.test(body)) {
    // `f(a, b), g(c)` : on coupe aux virgules hors parenthèses, puis on retire les arguments.
    const parts: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of body) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) {
        parts.push(current);
        current = '';
      } else current += ch;
    }
    parts.push(current);
    return parts.map((p) => normalizeName(p.replace(/\(.*$/s, '').trim())).filter(Boolean);
  }
  return body
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map(normalizeName);
}

type Acl = { verb: 'grant' | 'revoke'; targets: string[]; roles: string[]; text: string };

function parseAcl(statement: string): Acl | null {
  const m = statement.match(
    /^(grant|revoke)\s+([\s\S]+?)\s+on\s+([\s\S]+?)\s+(to|from)\s+([\s\S]+)$/i,
  );
  if (!m) return null;
  const verb = m[1].toLowerCase() as 'grant' | 'revoke';
  if (
    (verb === 'grant' && m[4].toLowerCase() !== 'to') ||
    (verb === 'revoke' && m[4].toLowerCase() !== 'from')
  ) {
    return null;
  }
  const roles = m[5]
    .replace(/\s+with\s+grant\s+option.*$/i, '')
    .replace(/\s+(cascade|restrict)\s*$/i, '')
    .replace(/\s+granted\s+by\s+.*$/i, '')
    .split(',')
    .map((r) => r.trim().replace(/"/g, '').toLowerCase())
    .filter(Boolean);
  return { verb, targets: targetsOf(m[3], 'any'), roles, text: statement };
}

// Une instruction CREATE qui introduit un objet gardé, ou null.
function parseCreate(statement: string): CreatedObject | null {
  const table = statement.match(/^create (?:unlogged )?table (?:if not exists )?([\w."]+)/i);
  if (table) {
    return {
      kind: 'table',
      name: normalizeName(table[1]),
      orReplace: false,
      isTrigger: false,
      securityInvoker: false,
    };
  }
  const view = statement.match(/^create (or replace )?(materialized )?view ([\w."]+)/i);
  if (view) {
    return {
      kind: view[2] ? 'matview' : 'view',
      name: normalizeName(view[3]),
      orReplace: Boolean(view[1]),
      isTrigger: false,
      securityInvoker: /with\s*\(\s*[^)]*security_invoker\s*=\s*(true|on)/i.test(statement),
    };
  }
  const sequence = statement.match(
    /^create (?:unlogged |temporary |temp )?sequence (?:if not exists )?([\w."]+)/i,
  );
  if (sequence) {
    return {
      kind: 'sequence',
      name: normalizeName(sequence[1]),
      orReplace: false,
      isTrigger: false,
      securityInvoker: false,
    };
  }
  const fn = statement.match(/^create (or replace )?(?:function|procedure) ([\w."]+)\s*\(/i);
  if (fn) {
    return {
      kind: 'function',
      name: normalizeName(fn[2]),
      orReplace: Boolean(fn[1]),
      isTrigger: /\breturns\s+trigger\b/i.test(statement),
      securityInvoker: false,
    };
  }
  return null;
}

export function analyzeMigration(sql: string, known: ReadonlySet<string>): Analysis {
  const noGrant = new Set<string>();
  for (const m of sql.matchAll(NO_GRANT_MARKER)) noGrant.add(normalizeName(m[1]));

  const statements = stripSqlNoise(sql)
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const created: CreatedObject[] = [];
  const acls: Acl[] = [];

  for (const statement of statements) {
    const created1 = parseCreate(statement);
    if (created1) {
      created.push(created1);
      continue;
    }
    const acl = parseAcl(statement);
    if (acl) acls.push(acl);
  }

  const violations: Violation[] = [];

  // Un objet « or replace » déjà connu garde son ACL : ce n'est pas un objet neuf.
  const fresh = created.filter((o) => !(o.orReplace && known.has(o.name)));

  for (const object of fresh) {
    if (object.isTrigger) continue;
    const mine = acls.filter((a) => a.targets.includes(object.name));
    const closesAnon = mine.some((a) => a.verb === 'revoke' && a.roles.includes('anon'));
    const opensToServer = mine.some(
      (a) =>
        a.verb === 'grant' && a.roles.length > 0 && a.roles.every((r) => ALLOWED_GRANTEES.has(r)),
    );
    const declaredNone = noGrant.has(object.name);

    if (!closesAnon) {
      violations.push({
        object: object.name,
        kind: object.kind,
        rule: 'R1-revoke-anon',
        detail: `aucun REVOKE nommant anon sur ${object.name} (« from public » seul est un no-op sur Supabase)`,
      });
    }
    if (!opensToServer && !declaredNone) {
      violations.push({
        object: object.name,
        kind: object.kind,
        rule: 'R2-grant-explicite',
        detail: `aucun GRANT explicite à authenticated ou service_role sur ${object.name} ; sans défaut d'image, personne ne pourrait l'utiliser. Aucun droit voulu ? déclarer « -- droits-explicites: aucun ${object.name} »`,
      });
    }
    if (object.kind === 'view' && !object.securityInvoker) {
      violations.push({
        object: object.name,
        kind: 'view',
        rule: 'R5-security-invoker',
        detail: `la vue ${object.name} doit déclarer WITH (security_invoker = true), sinon elle lit les tables sous les droits de son propriétaire et contourne la RLS`,
      });
    }
  }

  // R3 — aucun droit à anon ni à public dans une migration gardée (liste blanche vide, voir le test).
  for (const acl of acls) {
    if (acl.verb !== 'grant') continue;
    const wide = acl.roles.filter((r) => r === 'anon' || r === 'public');
    if (wide.length > 0) {
      violations.push({
        object: acl.targets.join(', '),
        kind: 'grant',
        rule: 'R3-grant-anon',
        detail: `GRANT à ${wide.join(', ')} : « rien pour anon sauf besoin prouvé » (${acl.text.slice(0, 90)})`,
      });
    }
  }

  return { created, violations };
}

/** Noms des objets créés (pour tenir le registre « déjà connu » d'un fichier à l'autre). */
export function createdNames(sql: string): string[] {
  return analyzeMigration(sql, new Set()).created.map((o) => o.name);
}
