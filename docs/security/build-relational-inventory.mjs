import fs from 'node:fs';

const read = (name) => {
  const b = fs.readFileSync(new URL(name, import.meta.url));
  return JSON.parse(b.toString(b[0] === 255 ? 'utf16le' : 'utf8').replace(/^\uFEFF/, ''));
};
const all = read('relational-fk-inventory.json');
const controls = read('relational-controls.json');
// Persist catalogue metadata as ordinary UTF-8, never business data.
for (const [name, data] of [
  ['relational-fk-inventory.json', all],
  ['relational-controls.json', controls],
])
  fs.writeFileSync(new URL(name, import.meta.url), `${JSON.stringify(data, null, 2)}\n`);
const pairs = all.filter((r) => r.child_scope.length && r.parent_scope.length);
const ident = (v) => `"${v.replaceAll('"', '""')}"`;
const literals = (v) => `'${v.replaceAll("'", "''")}'`;
const selects = [];
const rows = [];
for (const r of pairs) {
  const match = r.definition.match(/^FOREIGN KEY \(([^)]+)\) REFERENCES [^(]+\(([^)]+)\)/);
  if (!match) throw new Error('unrecognized catalogue FK');
  const child = match[1].split(',').map((v) => v.trim());
  const parent = match[2].split(',').map((v) => v.trim());
  const childTenant = r.child_scope.find((s) => ['merchant_account_id', 'tenant_id'].includes(s));
  const parentTenant = r.parent_scope.find((s) => ['merchant_account_id', 'tenant_id'].includes(s));
  const common = [];
  if (childTenant && parentTenant) common.push([childTenant, parentTenant]);
  if (r.child_scope.includes('shop_id') && r.parent_scope.includes('shop_id'))
    common.push(['shop_id', 'shop_id']);
  const predicates = common.map(([c, p]) =>
    c === 'shop_id'
      ? '(c.shop_id IS NOT NULL AND p.shop_id IS NOT NULL AND c.shop_id <> p.shop_id)'
      : `c.${ident(c)} IS DISTINCT FROM p.${ident(p)}`,
  );
  if (predicates.length)
    selects.push(
      `SELECT ${literals(`${r.child_table}.${r.constraint_name}`)} AS reference, count(*) AS inconsistent_count\nFROM public.${ident(r.child_table)} c LEFT JOIN public.${ident(r.parent_table)} p ON ${child.map((c, i) => `c.${ident(c)} = p.${ident(parent[i])}`).join(' AND ')}\nWHERE ${child.map((c) => `c.${ident(c)} IS NOT NULL`).join(' AND ')}\n  AND (p.${ident(parent[0])} IS NULL OR ${predicates.join(' OR ')})`,
    );
  const structural = common
    .filter(([childScope, parentScope]) =>
      child.some((c, i) => c === childScope && parent[i] === parentScope),
    )
    .map(([c, p]) => (c === p ? c : `${c} → ${p}`));
  const triggers = controls.triggers.filter((t) => t.table === r.child_table);
  const relevant = triggers.filter((t) => /assert_.*integrity/.test(t.function));
  const checks = controls.policies.filter(
    (p) =>
      p.tablename === r.child_table &&
      ['INSERT', 'UPDATE', 'ALL'].includes(p.cmd) &&
      p.roles.some((role) => ['authenticated', 'public'].includes(role)),
  );
  const policyRelational = checks.some((p) =>
    new RegExp(`\\bFROM\\s+(?:public\\.)?${r.parent_table}\\b`, 'i').test(
      p.with_check ?? p.qual ?? '',
    ),
  );
  // These exact references were compared with the installed trigger bodies.
  // No inference from a trigger name alone, or from current_shop_role's name.
  const checkedTriggerColumns = {
    product_bundle_component: ['bundle_product_id', 'component_product_id'],
    purchase_lot_line: ['purchase_lot_id', 'product_id'],
    product_ad_spend: ['product_id', 'purchase_lot_id'],
    purchase_lot_line_allocation: ['order_line_id', 'purchase_lot_line_id'],
  };
  const checkedTrigger =
    relevant.length > 0 && child.every((c) => checkedTriggerColumns[r.child_table]?.includes(c));
  const alternateGuard = all.find((other) => {
    if (
      other.constraint_name === r.constraint_name ||
      other.child_table !== r.child_table ||
      other.parent_table !== r.parent_table ||
      !other.validated
    )
      return false;
    const parts = other.definition.match(/^FOREIGN KEY \(([^)]+)\) REFERENCES [^(]+\(([^)]+)\)/);
    if (!parts) return false;
    const childKeys = parts[1].split(',').map((v) => v.trim());
    const parentKeys = parts[2].split(',').map((v) => v.trim());
    const includes = (c, p) => childKeys.some((key, i) => key === c && parentKeys[i] === p);
    return (
      child.every((c, i) => includes(c, parent[i])) &&
      common.every(
        ([c, p]) =>
          includes(c, p) &&
          (child.includes(c) ||
            controls.columns.some(
              (column) =>
                column.table === r.child_table && column.column === c && column.nullable === 'NO',
            )),
      )
    );
  });
  const writePolicy = (command) =>
    !r.child_rls ||
    checks.some(
      (p) =>
        [command, 'ALL'].includes(p.cmd) &&
        p.permissive === 'PERMISSIVE' &&
        !/^\(?false\)?$/i.test((p.with_check ?? p.qual ?? '').trim()),
    );
  const jwtWrite =
    (r.authenticated_insert_fk_columns && writePolicy('INSERT')) ||
    (r.authenticated_update_fk_columns && writePolicy('UPDATE'));
  const evaluation =
    structural.length === common.length && common.length
      ? 'Scope structurelle présente (FK) ; autorisation transport distincte'
      : alternateGuard
        ? `Scope protégée par la FK composite parallèle ${alternateGuard.constraint_name} ; ne pas compter le FK simple comme faille`
        : checkedTrigger
          ? 'Comparaison tenant/shop du parent présente dans trigger ; pas de nouveau test de transport'
          : policyRelational
            ? 'WITH CHECK relationnel présent ; chemin privilégié à investiguer'
            : jwtWrite
              ? 'NEEDS INVESTIGATION : colonnes FK insérables/modifiables par JWT, appartenance parent non structurellement démontrée'
              : 'NEEDS INVESTIGATION : écriture JWT non établie (GRANT ou policy absente) ; tracer RPC/services privilégiés';
  rows.push(
    `| ${r.child_table} → ${r.parent_table} | ${r.constraint_name} | ${structural.join(', ') || 'Aucune scope dans FK'} | INSERT ${r.authenticated_insert_fk_columns}, UPDATE ${r.authenticated_update_fk_columns} | ${relevant.map((t) => t.function).join(', ') || 'Aucun trigger relationnel spécialisé'} | ${policyRelational ? 'Sous-requête parent présente : vérifier égalités' : 'RLS ne démontre pas la relation'} | ${evaluation} |`,
  );
}
fs.writeFileSync(
  new URL('count-inconsistent-business-references.sql', import.meta.url),
  `-- Lecture seule. À exécuter humainement avec visibilité de toutes les lignes ; jamais via anon/RLS masquant des données.\n-- Comptes uniquement. Les shops facultatifs ne sont comparés que lorsque les deux sont non NULL.\n-- Une référence nullable absente est légitime. Un résultat positif impose revue, pas nettoyage automatique.\nBEGIN TRANSACTION READ ONLY;\nSET LOCAL statement_timeout = '30s';\nSET LOCAL row_security = off;\n${selects.join('\nUNION ALL\n')}\nORDER BY reference;\nROLLBACK;\n`,
);
fs.writeFileSync(
  new URL('relational-reference-register.md', import.meta.url),
  `# Inventaire relationnel — catalogue local au 12 novembre 2026\n\n${all.length} FK public → public ; ${pairs.length} ont une scope marchand/boutique des deux côtés. Toutes ces références sont listées ci-dessous. Les ${all.length - pairs.length} autres sont conservées dans le JSON intégral, notamment identités Auth/merchant_account ou relations sans scope dupliquée.\n\nCe tableau vérifie la présence structurelle des contrôles, pas l'exécution complète de chaque transport. RLS de la ligne enfant et assign_default_store_context ne prouvent pas l'appartenance du parent. Un trigger spécialisé peut couvrir certains parents et en oublier d'autres : lire son corps dans relational-controls.json. Un rôle BYPASSRLS n'est pas protégé par une policy. Pas de nouvelle exploitation pour étendre le registre des failles confirmées. Les GRANT utilisent has_column_privilege pour toutes les colonnes de chaque FK (droits hérités inclus), et ne prouvent pas à eux seuls qu'une ligne valide pourrait être écrite.\n\n| Référence | Contrainte | Scope dans FK | GRANT authenticated colonnes FK | Trigger candidat | WITH CHECK | Évaluation |\n|---|---|---|---|---|---|---|\n${rows.join('\n')}\n\nLe comptage généré est une revue structurelle de tenant et de shop non NULL, pas une validation de toute règle métier (par exemple allocation.order_id = order_line.order_id). Le SQL est limité à 30 s et read-only ; timeout ou erreur signifie résultat incomplet, pas zéro incohérence. La production peut diverger du catalogue local ; contrôler son catalogue avant application.\n`,
);
