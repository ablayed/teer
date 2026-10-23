-- V12b: consolidate the authenticated app-layout bootstrap reads.
-- Consent documents remain on their existing path.
create function public.get_app_bootstrap()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  with member as (
    select m.merchant_account_id, m.role
    from public.merchant_member as m
    where m.user_id = (select auth.uid())
    limit 1
  ), account as (
    select a.id, a.onboarded_at
    from public.merchant_account as a
    join member as m on m.merchant_account_id = a.id
    where a.deleted_at is null
  )
  select pg_catalog.jsonb_build_object(
    'stores', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(s) - 'ordinality' order by s.ordinality) from public.list_my_stores() with ordinality as s), '[]'::jsonb),
    'member', (select pg_catalog.to_jsonb(m) from member as m),
    'account', (select pg_catalog.to_jsonb(a) from account as a)
  );
$function$;
revoke all on function public.get_app_bootstrap() from public, anon, authenticated, service_role;
grant execute on function public.get_app_bootstrap() to authenticated;
