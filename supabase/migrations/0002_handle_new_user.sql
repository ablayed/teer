create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account_id uuid;
  v_account_name text;
begin
  v_account_name := coalesce(nullif(split_part(new.email, '@', 1), ''), 'marchand');

  insert into public.merchant_account (name, owner_user_id)
  values (v_account_name, new.id)
  returning id into v_account_id;

  insert into public.merchant_member (merchant_account_id, user_id, role)
  values (v_account_id, new.id, 'owner');

  insert into public.audit_log (merchant_account_id, actor_user_id, action, resource_type, resource_id)
  values (v_account_id, new.id, 'account.created', 'merchant_account', v_account_id);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
