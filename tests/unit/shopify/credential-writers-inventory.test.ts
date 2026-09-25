// SHOPIFY-EXPIRING-TOKENS-01 — preuve 12 : les huit écrivains de credentials passent par une
// primitive. Vérifié par RECHERCHE sur le dépôt, jamais par revue : un neuvième écrivain direct,
// ou le retour d'une écriture directe, fait rougir ce test.
//
// Les neuf colonnes sont l'union écrite par les chemins Shopify sur `shop` (0158, en-tête).
// Limite assumée de la recherche : elle suit la chaîne `.from('shop')` → premier appel de
// méthode ; une écriture passée par une variable intermédiaire lui échapperait. Aucun site de ce
// type n'existe à la date du lot (vérifié par la même recherche : chaque `.from('shop')` est
// suivi, dans la même chaîne, de son premier appel).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const CREDENTIAL_COLUMNS = [
  'access_token_encrypted',
  'refresh_token_encrypted',
  'access_token_expires_at',
  'refresh_token_expires_at',
  'scopes',
  'status',
  'updated_at',
  'shopify_client_id',
  'uninstalled_at',
];

function listFiles(dir: string, extensions: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...listFiles(path, extensions));
    } else if (extensions.some((extension) => path.endsWith(extension))) {
      out.push(path);
    }
  }
  return out;
}

// Texte entre la parenthèse ouvrante à `openIndex` et sa fermante (équilibrée).
function balancedArgs(source: string, openIndex: number): string {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  return source.slice(openIndex + 1);
}

type ShopWrite = { file: string; method: string; columns: string[] };

function directShopWrites(): ShopWrite[] {
  const files = ['app', 'lib', 'scripts', 'components'].flatMap((dir) =>
    listFiles(join(ROOT, dir), ['.ts', '.tsx', '.mjs']),
  );
  const writes: ShopWrite[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const pattern = /\.from\(\s*['"]shop['"]\s*\)/g;
    for (const match of source.matchAll(pattern)) {
      const after = source.slice((match.index ?? 0) + match[0].length);
      const call = /^\s*\.(\w+)\(/.exec(after);
      if (!call || !['update', 'insert', 'upsert', 'delete'].includes(call[1])) continue;
      const args = balancedArgs(after, call[0].length - 1);
      const columns = CREDENTIAL_COLUMNS.filter((column) =>
        new RegExp(`(^|[\\s{,])${column}\\s*[:,}]|\\.\\.\\.`).test(args),
      );
      writes.push({ file: relative(ROOT, file).replaceAll('\\', '/'), method: call[1], columns });
    }
  }
  return writes;
}

describe('preuve 12 — aucun écrivain direct de credentials Shopify ne subsiste', () => {
  it('aucune écriture directe des neuf colonnes sur `shop` dans app/, lib/, scripts/, components/', () => {
    const offending = directShopWrites().filter((write) => write.columns.length > 0);
    expect(offending).toEqual([]);
  });

  it('les seules écritures directes restantes sur `shop` sont inventoriées et hors credentials', () => {
    const remaining = directShopWrites().map((write) => `${write.file}:${write.method}`);
    // lib/shopify/reconcile.ts n'écrit que `last_reconciled_at` (curseur de réconciliation).
    expect(remaining.sort()).toEqual([
      'lib/shopify/reconcile.ts:update',
      'lib/shopify/reconcile.ts:update',
    ]);
  });

  it('les deux primitives non fencées de 0155 n’ont plus aucun appelant applicatif', () => {
    const files = ['app', 'lib', 'scripts', 'components'].flatMap((dir) =>
      listFiles(join(ROOT, dir), ['.ts', '.tsx', '.mjs']),
    );
    const callers = files.filter((file) => {
      if (file.endsWith('database.types.ts')) return false;
      const source = readFileSync(file, 'utf8');
      return /['"](link_shopify_embedded_shop|release_shopify_shop_app_identity)['"]/.test(source);
    });
    expect(callers.map((file) => relative(ROOT, file))).toEqual([]);
  });

  it('les écritures SQL sur `shop` sont inventoriées : toute nouvelle migration qui en ajoute fait rougir ce test', () => {
    const migrations = listFiles(join(ROOT, 'supabase/migrations'), ['.sql']);
    const writers = migrations
      .filter((file) =>
        /(insert\s+into|update)\s+public\.shop(\s+(as\s+)?s)?\s*(\(|$|set\b)/im.test(
          readFileSync(file, 'utf8'),
        ),
      )
      .map((file) => relative(join(ROOT, 'supabase/migrations'), file));
    expect(writers.sort()).toEqual([
      // Rétro-remplissages ponctuels et `handle_new_user` (boutique `manual-….internal`) :
      // domaine refusé par le bail, exception hors protocole Shopify.
      '0126_workspace_store_foundation.sql',
      // Finalisation WooCommerce (`new_shop`) : exception hors protocole Shopify.
      '0154_r2_woocommerce_first_shop.sql',
      // Primitives non fencées de 0155 : plus aucun appelant (test ci-dessus), fermeture en 0160.
      '0155_sec_shop_claim_01_shop_identity_writes.sql',
      // Primitives fencées.
      '0158_schema_token_lease_01_shopify_token_lease.sql',
      '0159_schema_lease_closure_01_fenced_destructive_primitives.sql',
    ]);
  });
});
