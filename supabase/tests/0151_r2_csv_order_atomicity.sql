-- Contrat SQL R2.1/R2.2 — à exécuter dans une transaction sur une base de test
-- après 0151. Ce fichier ne conserve aucune donnée et ne contient aucun
-- TypeScript qui référence le schéma avant la confirmation de production.
begin;

do $$
declare
  v_nullable text;
  v_connection_index text;
  v_native_index text;
  v_function_auth boolean;
  v_connection_context_fk text;
begin
  select is_nullable into v_nullable
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'external_ref'
    and column_name = 'store_connection_id';

  if v_nullable <> 'YES' then
    raise exception 'r2_expected_nullable_store_connection_id actual=%', v_nullable;
  end if;

  select indexdef into v_connection_index
  from pg_indexes
  where schemaname = 'public'
    and tablename = 'external_ref'
    and indexname = 'external_ref_connection_type_external_key';

  if v_connection_index is distinct from
    'CREATE UNIQUE INDEX external_ref_connection_type_external_key ON public.external_ref USING btree (store_connection_id, entity_type, external_id)'
  then
    raise exception 'r2_connection_index_changed definition=%', v_connection_index;
  end if;

  select indexdef into v_native_index
  from pg_indexes
  where schemaname = 'public'
    and tablename = 'external_ref'
    and indexname = 'external_ref_native_source_entity_external_key';

  if v_native_index not like '%WHERE (store_connection_id IS NULL)%' then
    raise exception 'r2_native_source_index_missing_or_unscoped definition=%', v_native_index;
  end if;

  select has_function_privilege(
    'authenticated',
    'public.create_csv_order(uuid, uuid, uuid, text, text, numeric, text, jsonb, jsonb, jsonb)',
    'EXECUTE'
  ) into v_function_auth;

  if v_function_auth then
    raise exception 'r2_create_csv_order_exposed_to_authenticated';
  end if;

  select pg_get_constraintdef(oid) into v_connection_context_fk
  from pg_constraint
  where conrelid = 'public.external_ref'::regclass
    and conname = 'external_ref_connection_tenant_shop_fk';

  if v_connection_context_fk is distinct from
    'FOREIGN KEY (store_connection_id, merchant_account_id, shop_id) REFERENCES store_connection(id, merchant_account_id, shop_id) ON DELETE CASCADE'
  then
    raise exception 'r2_connection_context_fk_missing definition=%', v_connection_context_fk;
  end if;
end;
$$;

do $$
declare
  v_merchant_account_id uuid;
  v_shop_id uuid;
  v_order_id uuid;
  v_order_key text := format('r2-sql-%s', txid_current());
  v_invalid_order_key text := format('r2-invalid-sql-%s', txid_current());
  v_order_count integer;
  v_line_count integer;
begin
  select merchant_account_id, id
  into v_merchant_account_id, v_shop_id
  from public.shop
  order by id
  limit 1;

  if v_shop_id is null then
    raise exception 'r2_sql_test_requires_a_shop';
  end if;

  select public.create_csv_order(
    v_merchant_account_id,
    v_shop_id,
    null,
    v_order_key,
    'R2 SQL test',
    1200,
    'XOF',
    '[{"title":"Ligne SQL","quantity":2}]'::jsonb,
    '{"address1":"Test SQL"}'::jsonb,
    '[{"raw_title":"Ligne SQL","raw_sku":null,"qty":2,"match_status":"unresolved"}]'::jsonb
  ) into v_order_id;

  begin
    perform public.create_csv_order(
      v_merchant_account_id,
      v_shop_id,
      null,
      v_order_key,
      'R2 SQL test duplicate',
      1200,
      'XOF',
      '[{"title":"Ligne SQL","quantity":2}]'::jsonb,
      '{"address1":"Test SQL"}'::jsonb,
      '[{"raw_title":"Ligne SQL","raw_sku":null,"qty":2,"match_status":"unresolved"}]'::jsonb
    );
    raise exception 'r2_duplicate_order_key_was_accepted';
  exception
    when unique_violation then null;
  end;

  select count(*) into v_order_count
  from public.orders o
  join public.external_ref er on er.entity_id = o.id
  where er.merchant_account_id = v_merchant_account_id
    and er.shop_id = v_shop_id
    and er.store_connection_id is null
    and er.source_namespace = 'csv'
    and er.entity_type = 'order'
    and er.external_id = v_order_key;

  if v_order_count <> 1 then
    raise exception 'r2_expected_one_order_after_duplicate actual=%', v_order_count;
  end if;

  select count(*) into v_line_count
  from public.order_line ol
  where ol.order_id = v_order_id
    and ol.merchant_account_id = v_merchant_account_id
    and ol.shop_id = v_shop_id;

  if v_line_count <> 1 then
    raise exception 'r2_order_line_shop_inheritance_failed actual=%', v_line_count;
  end if;

  begin
    perform public.create_csv_order(
      v_merchant_account_id,
      v_shop_id,
      null,
      v_invalid_order_key,
      'R2 SQL test invalid lines',
      1200,
      'XOF',
      '[{"title":"Ligne SQL","quantity":2}]'::jsonb,
      '{"address1":"Test SQL"}'::jsonb,
      '[
        {"raw_title":"Ligne valide","raw_sku":null,"qty":1,"match_status":"unresolved"},
        {"raw_title":null,"raw_sku":null,"qty":1,"match_status":"unresolved"}
      ]'::jsonb
    );
    raise exception 'r2_invalid_order_lines_were_accepted';
  exception
    when not_null_violation then null;
  end;

  select count(*) into v_order_count
  from public.external_ref er
  where er.merchant_account_id = v_merchant_account_id
    and er.shop_id = v_shop_id
    and er.store_connection_id is null
    and er.source_namespace = 'csv'
    and er.entity_type = 'order'
    and er.external_id = v_invalid_order_key;

  if v_order_count <> 0 then
    raise exception 'r2_partial_order_survived_invalid_line actual=%', v_order_count;
  end if;
end;
$$;

rollback;
