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
    (p) => p.tablename === r.child_table && ['INSERT', 'UPDATE', 'ALL'].includes(p.cmd),
  );
  const policyRelational = checks.some((p) => (p.with_check ?? '').includes(r.parent_table));
  rows.push(
    `| ${r.child_table} → ${r.parent_table} | ${r.constraint_name} | ${structural.join(', ') || 'Aucune scope dans FK'} | ${relevant.map((t) => t.function).join(', ') || 'Aucun trigger relationnel spécialisé'} | ${policyRelational ? 'Relation mentionnée : revue nécessaire' : 'RLS ne démontre pas la relation'} | ${structural.length === common.length && common.length ? 'Contrainte structurelle présente ; transport non retesté' : 'NEEDS INVESTIGATION : vérifier chaque référence et ses appelants'} |`,
  );
}
fs.writeFileSync(
  new URL('count-inconsistent-business-references.sql', import.meta.url),
  `-- Lecture seule. À exécuter humainement avec visibilité de toutes les lignes ; jamais via anon/RLS masquant des données.\n-- Comptes uniquement. Les shops facultatifs ne sont comparés que lorsque les deux sont non NULL.\n-- Une référence nullable absente est légitime. Un résultat positif impose revue, pas nettoyage automatique.\nBEGIN TRANSACTION READ ONLY;\nSET LOCAL statement_timeout = '30s';\n${selects.join('\nUNION ALL\n')}\nORDER BY reference;\nROLLBACK;\n`,
);
fs.writeFileSync(
  new URL('relational-reference-register.md', import.meta.url),
  `# Inventaire relationnel — catalogue local au 12 novembre 2026\n\n${all.length} FK public → public ; ${pairs.length} ont une scope marchand/boutique des deux côtés. Toutes ces références sont listées ci-dessous. Les ${all.length - pairs.length} autres sont conservées dans le JSON intégral, notamment identités Auth/merchant_account ou relations sans scope dupliquée.\n\nCe tableau vérifie la présence structurelle des contrôles, pas l'exécution complète de chaque transport. RLS de la ligne enfant et assign_default_store_context ne prouvent pas l'appartenance du parent. Un trigger spécialisé peut couvrir certains parents et en oublier d'autres : lire son corps dans relational-controls.json. Un rôle BYPASSRLS n'est pas protégé par une policy. Pas de nouvelle exploitation pour étendre le registre des failles confirmées.\n\n| Référence | Contrainte | Scope dans FK | Trigger candidat | WITH CHECK | Évaluation |\n|---|---|---|---|---|---|\n${rows.join('\n')}\n\nLe comptage généré est une revue structurelle de tenant et de shop non NULL, pas une validation de toute règle métier (par exemple allocation.order_id = order_line.order_id). Le SQL est limité à 30 s et read-only ; timeout ou erreur signifie résultat incomplet, pas zéro incohérence. La production peut diverger du catalogue local ; contrôler son catalogue avant application.\n`,
);
