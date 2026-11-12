-- SEC-A-002. PREPARED ONLY; production count and explicit human db push required.
-- No financial data is repaired, moved or deleted. Positive preflight => full abort.
-- Retain ON DELETE RESTRICT semantics; the composite FK also protects concurrent
-- writes and changes of the referenced category's tenant, including BYPASSRLS.
-- One extra unique index is necessary because PostgreSQL requires the referenced
-- pair to be unique. No new relation/function or privilege grant is introduced.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
lock table public.expense_category, public.expense in share row exclusive mode;

do $$
declare
  inconsistent_count bigint;
begin
  select count(*) into inconsistent_count
  from public.expense e
  left join public.expense_category c on c.id = e.category_id
  where c.id is null
     or c.merchant_account_id is distinct from e.merchant_account_id;

  if inconsistent_count > 0 then
    raise exception 'SEC-A-002 preflight: % inconsistent expense references; human review required', inconsistent_count
      using errcode = '23514';
  end if;
end;
$$;

alter table public.expense_category
  add constraint expense_category_id_tenant_unique unique (id, merchant_account_id);

alter table public.expense
  add constraint expense_category_tenant_fk
  foreign key (category_id, merchant_account_id)
  references public.expense_category (id, merchant_account_id)
  on delete restrict;

-- No code/schema caller refers to the old constraint name; replacement remains
-- the single expense→category relation for PostgREST relationship inference.
alter table public.expense drop constraint expense_category_id_fkey;

commit;
