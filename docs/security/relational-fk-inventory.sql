-- Catalogue uniquement. Lecture seule ; aucune ligne métier retournée.
SELECT jsonb_pretty(jsonb_agg(to_jsonb(q) ORDER BY child_table, constraint_name))
FROM (
  SELECT c.conname AS constraint_name,
    child.relname AS child_table, parent.relname AS parent_table,
    pg_get_constraintdef(c.oid) AS definition,
    c.convalidated AS validated,
    NOT EXISTS (SELECT 1 FROM unnest(c.conkey) k(attnum)
      WHERE NOT has_column_privilege('authenticated', child.oid, k.attnum, 'INSERT'))
      AS authenticated_insert_fk_columns,
    NOT EXISTS (SELECT 1 FROM unnest(c.conkey) k(attnum)
      WHERE NOT has_column_privilege('authenticated', child.oid, k.attnum, 'UPDATE'))
      AS authenticated_update_fk_columns,
    ARRAY(SELECT a.attname FROM pg_attribute a
      WHERE a.attrelid = child.oid AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attname IN ('merchant_account_id', 'tenant_id', 'shop_id')) AS child_scope,
    ARRAY(SELECT a.attname FROM pg_attribute a
      WHERE a.attrelid = parent.oid AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attname IN ('merchant_account_id', 'tenant_id', 'shop_id')) AS parent_scope,
    child.relrowsecurity AS child_rls
  FROM pg_constraint c
  JOIN pg_class child ON child.oid = c.conrelid
  JOIN pg_class parent ON parent.oid = c.confrelid
  JOIN pg_namespace cn ON cn.oid = child.relnamespace
  JOIN pg_namespace pn ON pn.oid = parent.relnamespace
  WHERE c.contype = 'f' AND cn.nspname = 'public' AND pn.nspname = 'public'
) q;
