#!/usr/bin/env node
/**
 * Réapplique, de façon REPRODUCTIBLE, le seul écart connu entre les types
 * générés par `supabase gen types` et le contrat d'exécution réel.
 *
 * ── Pourquoi cet écart existe ────────────────────────────────────────────────
 * Depuis la migration 0126, `shop_id` est `NOT NULL` sur les tables scopées par
 * boutique. Le générateur en déduit donc `shop_id: string` OBLIGATOIRE dans le
 * type `Insert`. Mais chacune de ces tables porte un trigger BEFORE INSERT,
 * `assign_default_store_context` (0126 pour 10 tables, 0127 pour `call_log` et
 * `order_state_transition`), qui renseigne la colonne quand l'insertion l'omet.
 * Une insertion sans `shop_id` est donc PARFAITEMENT VALIDE à l'exécution — le
 * générateur ne voit pas les triggers, il ne peut pas le savoir.
 *
 * Sans cet override, ~105 fixtures RLS qui exercent volontairement ce chemin
 * (et donc le trigger lui-même) ne compileraient plus, et le seul moyen de les
 * rendre vertes serait de retirer la couverture du trigger.
 *
 * ── Ce que cet override ne fait PAS ──────────────────────────────────────────
 * Il ne relâche RIEN d'autre : `Row` garde `shop_id: string` (la colonne est
 * bien NOT NULL en lecture) et `Update` reste inchangé. Il ne dispense pas non
 * plus le code applicatif de passer la boutique ACTIVE : rendre `shop_id`
 * optionnel exprime « le trigger sait retomber sur la boutique par DÉFAUT »,
 * jamais « la boutique n'a pas d'importance ». Un site applicatif qui laisse le
 * trigger choisir écrit dans la boutique par défaut, ce qui est un défaut
 * fonctionnel dès que l'utilisateur a sélectionné une autre boutique — c'est
 * précisément ce que l'audit des sites d'écriture a corrigé, et ce que les
 * tests dédiés verrouillent.
 *
 * Lancé automatiquement par `pnpm db:types`, donc jamais perdu à la
 * régénération suivante. Idempotent.
 *
 * ── Ordre imposé dans `db:types` : gen → `biome format` → CE script ──────────
 * Le générateur émet du TypeScript SANS point-virgule ; les motifs ci-dessous en
 * exigent un. Lancer ce script sur la sortie BRUTE ne patcherait donc rien et
 * échouerait sur la garde des 12 tables — c'est exactement ce qui est arrivé une
 * fois. Le `biome format --write` intercalé n'est pas cosmétique : il normalise le
 * fichier dans la forme que ce script sait reconnaître. Ne pas le retirer.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'lib/supabase/database.types.ts';

// Tables portant `assign_default_store_context` (BEFORE INSERT).
const TRIGGERED_TABLES = new Set([
  'call_log',
  'customer',
  'delivery_address',
  'order_line',
  'order_state_transition',
  'orders',
  'product',
  'product_bundle_component',
  'product_stock',
  'purchase_lot',
  'purchase_lot_line',
  'stock_movement',
]);

const source = readFileSync(FILE, 'utf8');
const lines = source.split('\n');

let currentTable = null;
let section = null;
let patched = 0;

const tableRe = /^ {6}([a-z_]+): \{$/;
const sectionRe = /^ {8}(Row|Insert|Update): \{$/;
const shopIdRe = /^ {10}shop_id: string;$/;
const alreadyPatchedRe = /^ {10}shop_id\?: string;$/;

for (let i = 0; i < lines.length; i += 1) {
  const tableMatch = tableRe.exec(lines[i]);
  if (tableMatch) {
    currentTable = tableMatch[1];
    section = null;
    continue;
  }

  const sectionMatch = sectionRe.exec(lines[i]);
  if (sectionMatch) {
    section = sectionMatch[1];
    continue;
  }

  if (section !== 'Insert' || !TRIGGERED_TABLES.has(currentTable)) {
    continue;
  }

  if (shopIdRe.test(lines[i])) {
    lines[i] = '          shop_id?: string;';
    patched += 1;
  } else if (alreadyPatchedRe.test(lines[i])) {
    // Rejouer le script sur un fichier déjà traité doit être un no-op, pas une
    // erreur : `pnpm db:types` régénère puis repatche, mais le script peut
    // aussi être lancé seul pour vérifier l'état du fichier committé.
    patched += 1;
  }
}

if (patched !== TRIGGERED_TABLES.size) {
  process.stderr.write(
    `apply-database-types-overrides: ${patched} table(s) patchée(s), ${TRIGGERED_TABLES.size} attendue(s). Le format du fichier généré a changé, ou une table a perdu son trigger. Vérifier avant de committer — ne pas ignorer.\n`,
  );
  process.exit(1);
}

writeFileSync(FILE, lines.join('\n'), 'utf8');
process.stdout.write(
  `apply-database-types-overrides: shop_id rendu optionnel sur ${patched} types Insert.\n`,
);
