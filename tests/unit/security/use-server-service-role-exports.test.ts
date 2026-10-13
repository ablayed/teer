/**
 * Garde : aucune fonction exportée d'un fichier `'use server'` ne lit en service-role sur la foi
 * d'un argument, sans lire la session elle-même.
 *
 * Pourquoi : Next enregistre chaque export d'un fichier `'use server'` comme une Server Action,
 * un point d'entrée HTTP que les gardes du code appelant ne protègent pas. Les lectures par
 * identifiant `getMerchantMemberForUser(userId)` et `getMerchantAccountById(accountId)` vivent
 * pour cette raison dans `lib/merchant/member-account.ts`, qui n'est pas un fichier d'actions.
 *
 * Portée, à ne pas élargir : analyse statique du dépôt. Elle voit une fonction exportée qui
 * construit ELLE-MÊME un client service-role. Elle ne voit pas une délégation à un helper privé,
 * ni une action `next-safe-action`, dont les gardes sont dans la chaîne (`requireRole`).
 * « Lire la session » veut dire : appeler `auth.getUser()`, ou une fonction du dépôt qui
 * l'appelle elle-même. La garde ne dit rien de ce que la fonction fait ensuite de ses arguments :
 * un identifiant de boutique reçu de l'appelant reste à confronter aux droits du membre.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const SOURCE_ROOTS = ['app', 'lib', 'components'];
const HELPERS_MODULE = '@/lib/merchant/member-account';
const HELPERS_FILE = 'lib/merchant/member-account.ts';

type Source = { file: string; node: ts.SourceFile };
type ExportedFunction = { body: ts.Node; file: string; name: string; parameters: number };

function parse(file: string, text: string): Source {
  return {
    file,
    node: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
  };
}

function* walkFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(path);
    else if (/\.tsx?$/.test(entry.name)) yield path;
  }
}

function loadRepository(): Source[] {
  return SOURCE_ROOTS.flatMap((root) =>
    [...walkFiles(join(ROOT, root))].map((path) =>
      parse(relative(ROOT, path).replace(/\\/g, '/'), readFileSync(path, 'utf8')),
    ),
  );
}

function isUseServerFile(source: Source): boolean {
  const first = source.node.statements[0];
  return (
    first !== undefined &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === 'use server'
  );
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

/** Fonctions qui construisent un client service-role : leur corps nomme la clé. */
function serviceRoleFactories(sources: Source[]): Set<string> {
  const names = new Set<string>();
  for (const source of sources) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name &&
        node.body?.getText(source.node).includes('SUPABASE_SERVICE_ROLE_KEY')
      ) {
        names.add(node.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source.node);
  }
  return names;
}

function exportedFunctions(source: Source): ExportedFunction[] {
  const found: ExportedFunction[] = [];
  for (const statement of source.node.statements) {
    if (ts.isFunctionDeclaration(statement) && isExported(statement) && statement.body) {
      found.push({
        body: statement.body,
        file: source.file,
        name: statement.name?.text ?? '(anonyme)',
        parameters: statement.parameters.length,
      });
    }
    if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          found.push({
            body: init.body,
            file: source.file,
            name: declaration.name.getText(source.node),
            parameters: init.parameters.length,
          });
        }
      }
    }
  }
  return found;
}

function calls(body: ts.Node, predicate: (callee: string) => boolean): boolean {
  let hit = false;
  const visit = (node: ts.Node): void => {
    if (hit) return;
    if (ts.isCallExpression(node) && predicate(node.expression.getText())) {
      hit = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return hit;
}

const callsGetUser = (callee: string) => /\.auth\.getUser$/.test(callee);

/** Fonctions du dépôt qui lisent la session elles-mêmes (`auth.getUser()` dans leur corps). */
function sessionReaders(sources: Source[]): Set<string> {
  const names = new Set<string>();
  for (const source of sources) {
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        if (calls(node.body, callsGetUser)) names.add(node.name.text);
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (calls(node.initializer, callsGetUser)) names.add(node.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source.node);
  }
  return names;
}

/** Exports d'un fichier `'use server'` : argument de l'appelant, service-role, aucune session. */
function unguardedServiceRoleExports(sources: Source[]): string[] {
  const factories = serviceRoleFactories(sources);
  const readers = sessionReaders(sources);
  const readsSession = (callee: string) => callsGetUser(callee) || readers.has(callee);
  return sources
    .filter(isUseServerFile)
    .flatMap(exportedFunctions)
    .filter(
      (fn) =>
        fn.parameters > 0 &&
        (calls(fn.body, (callee) => factories.has(callee)) ||
          fn.body.getText().includes('SUPABASE_SERVICE_ROLE_KEY')) &&
        !calls(fn.body, readsSession),
    )
    .map((fn) => `${fn.file} :: ${fn.name}`);
}

/** Réexports (`export … from`) d'un module donné depuis un fichier `'use server'`. */
function reExportsOf(sources: Source[], moduleName: string): string[] {
  return sources
    .filter(isUseServerFile)
    .filter((source) =>
      source.node.statements.some(
        (statement) =>
          ts.isExportDeclaration(statement) &&
          statement.moduleSpecifier !== undefined &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          statement.moduleSpecifier.text === moduleName,
      ),
    )
    .map((source) => source.file);
}

const FACTORY = `
function createSupabaseAdminClient() {
  return createProtectedSupabaseClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}
`;
// La forme retirée de lib/actions/merchant.ts.
const FORMER_SHAPE = `'use server';
${FACTORY}
export async function getMerchantMemberForUser(userId: string) {
  const admin = createSupabaseAdminClient();
  return admin.from('merchant_member').select('merchant_account_id, role').eq('user_id', userId);
}
export const getMerchantAccountById = async (accountId: string) => {
  const admin = createSupabaseAdminClient();
  return admin.from('merchant_account').select('*').eq('id', accountId);
};
`;

describe("exports d'un fichier 'use server' et client service-role", () => {
  const repository = loadRepository();

  it('le détecteur reconnaît la forme retirée (déclaration et fonction fléchée)', () => {
    expect(unguardedServiceRoleExports([parse('fixture.ts', FORMER_SHAPE)])).toEqual([
      'fixture.ts :: getMerchantMemberForUser',
      'fixture.ts :: getMerchantAccountById',
    ]);
  });

  it("le détecteur ne signale ni une lecture qui tire l'identité de la session, ni un helper hors 'use server'", () => {
    const sessionDerived = `'use server';
${FACTORY}
export async function getMine(hint: string) {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  return createSupabaseAdminClient().from('merchant_member').select('role').eq('user_id', data.user?.id ?? hint);
}
`;
    expect(unguardedServiceRoleExports([parse('fixture.ts', sessionDerived)])).toEqual([]);
    expect(
      unguardedServiceRoleExports([parse('fixture.ts', FORMER_SHAPE.replace("'use server';", ''))]),
    ).toEqual([]);
  });

  it('une lecture de session faite par une fonction locale compte ; un simple homonyme, non', () => {
    const viaLocalReader = (readerBody: string) => `'use server';
${FACTORY}
async function getCurrentMember() {
  ${readerBody}
}
export async function getShopProducts(shopId: string) {
  const member = await getCurrentMember();
  return createSupabaseAdminClient().from('product').select('id').eq('shop_id', shopId).eq('merchant_account_id', member.id);
}
`;
    const real = viaLocalReader(
      'const supabase = await createSupabaseServerClient(); return (await supabase.auth.getUser()).data.user;',
    );
    const hollow = viaLocalReader("return { id: 'fixe' };");
    expect(unguardedServiceRoleExports([parse('fixture.ts', real)])).toEqual([]);
    expect(unguardedServiceRoleExports([parse('fixture.ts', hollow)])).toEqual([
      'fixture.ts :: getShopProducts',
    ]);
  });

  it("aucun export d'un fichier 'use server' ne lit en service-role sur un argument sans lire la session", () => {
    expect(repository.filter(isUseServerFile).length).toBeGreaterThan(20);
    expect(unguardedServiceRoleExports(repository)).toEqual([]);
  });

  it("les deux lectures marchand vivent hors de tout fichier 'use server'", () => {
    const helpers = repository.find((source) => source.file === HELPERS_FILE);
    expect(helpers, HELPERS_FILE).toBeDefined();
    if (!helpers) return;
    expect(isUseServerFile(helpers)).toBe(false);
    expect(
      exportedFunctions(helpers)
        .map((fn) => fn.name)
        .sort(),
    ).toEqual(['getMerchantAccountById', 'getMerchantMemberForUser']);

    expect(reExportsOf(repository, HELPERS_MODULE)).toEqual([]);

    const actions = repository.find((source) => source.file === 'lib/actions/merchant.ts');
    expect(actions && isUseServerFile(actions)).toBe(true);
    expect(actions ? exportedFunctions(actions).map((fn) => fn.name) : []).toEqual([
      'getMerchantAccount',
    ]);
  });

  it("le détecteur de réexport reconnaît un `export … from` dans un fichier 'use server'", () => {
    const reExport = `'use server';
export { getMerchantMemberForUser } from '${HELPERS_MODULE}';
`;
    expect(reExportsOf([parse('fixture.ts', reExport)], HELPERS_MODULE)).toEqual(['fixture.ts']);
  });
});
