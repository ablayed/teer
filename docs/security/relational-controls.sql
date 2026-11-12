-- Métadonnées des contrôles locaux, aucune donnée métier.
SELECT jsonb_pretty(jsonb_build_object(
 'triggers', (SELECT jsonb_agg(jsonb_build_object(
   'table', c.relname, 'name', t.tgname, 'definition', pg_get_triggerdef(t.oid),
   'function', p.proname, 'source', pg_get_functiondef(p.oid)))
   FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
   JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
   WHERE n.nspname='public' AND NOT t.tgisinternal),
 'policies', (SELECT jsonb_agg(to_jsonb(p)) FROM pg_policies p WHERE schemaname='public'),
 'columns', (SELECT jsonb_agg(jsonb_build_object('table',table_name,'column',column_name,'nullable',is_nullable))
   FROM information_schema.columns WHERE table_schema='public'
    AND column_name IN ('merchant_account_id','tenant_id','shop_id'))
));
