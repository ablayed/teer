create or replace function public.current_member_role(p_account uuid)
returns text language sql stable security definer set search_path = public as $$
  select role from public.merchant_member
  where merchant_account_id = p_account and user_id = auth.uid() limit 1
$$;

revoke all on function public.current_member_role(uuid) from public, anon;
grant execute on function public.current_member_role(uuid) to authenticated;

create table public.invitation (
  id uuid primary key default gen_random_uuid(),
  merchant_account_id uuid not null references public.merchant_account(id) on delete cascade,
  email text not null check (email = lower(email)),
  role text not null check (role in ('manager','agent')),
  token_hash bytea not null,
  status text not null default 'pending'
    check (status in ('pending','accepted','revoked','expired')),
  invited_by uuid not null references auth.users(id),
  accepted_by uuid references auth.users(id),
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index invitation_pending_email_unique_idx
  on public.invitation (merchant_account_id, lower(email))
  where status = 'pending';

create unique index invitation_token_hash_unique_idx
  on public.invitation (token_hash);

create index invitation_merchant_account_idx
  on public.invitation (merchant_account_id);

create index invitation_email_lower_idx
  on public.invitation (lower(email));

create table public.driver (
  id uuid primary key default gen_random_uuid(),
  merchant_account_id uuid not null references public.merchant_account(id) on delete cascade,
  full_name text not null,
  phone text not null,
  user_id uuid references auth.users(id),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index driver_merchant_account_idx
  on public.driver (merchant_account_id);

alter table public.invitation enable row level security;
alter table public.invitation force row level security;

create policy invitation_select
  on public.invitation
  for select
  to authenticated
  using (public.current_member_role(merchant_account_id) in ('owner','manager'));

create policy invitation_insert
  on public.invitation
  for insert
  to authenticated
  with check (
    public.current_member_role(merchant_account_id) in ('owner','manager')
    and role in ('manager','agent')
  );

create policy invitation_update
  on public.invitation
  for update
  to authenticated
  using (public.current_member_role(merchant_account_id) in ('owner','manager'))
  with check (public.current_member_role(merchant_account_id) in ('owner','manager'));

create policy invitation_delete
  on public.invitation
  for delete
  to authenticated
  using (public.current_member_role(merchant_account_id) = 'owner');

alter table public.driver enable row level security;
alter table public.driver force row level security;

create policy driver_select
  on public.driver
  for select
  to authenticated
  using (public.current_member_role(merchant_account_id) in ('owner','manager','agent'));

create policy driver_insert
  on public.driver
  for insert
  to authenticated
  with check (public.current_member_role(merchant_account_id) in ('owner','manager'));

create policy driver_update
  on public.driver
  for update
  to authenticated
  using (public.current_member_role(merchant_account_id) in ('owner','manager'))
  with check (public.current_member_role(merchant_account_id) in ('owner','manager'));

create policy driver_delete
  on public.driver
  for delete
  to authenticated
  using (public.current_member_role(merchant_account_id) in ('owner','manager'));

create trigger invitation_set_updated_at
  before update on public.invitation
  for each row
  execute function public.set_updated_at();

-- Existing indexes cover merchant_member(merchant_account_id, user_id)
-- through its unique constraint, and orders(merchant_account_id) through
-- orders_merchant_cod_status_idx.
create index if not exists orders_cod_status_idx
  on public.orders (cod_status);

create or replace function public.accept_invitation(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_token_hash bytea;
  v_invitation public.invitation%rowtype;
  v_user_email text;
  v_existing_member_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  v_token_hash := digest(p_token, 'sha256');

  select lower(email)
  into v_user_email
  from auth.users
  where id = auth.uid();

  if v_user_email is null then
    raise exception 'user_email_not_found';
  end if;

  select *
  into v_invitation
  from public.invitation
  where token_hash = v_token_hash
  for update;

  if not found then
    raise exception 'invalid_invitation';
  end if;

  if v_invitation.status = 'expired' then
    raise exception 'expired_invitation';
  end if;

  if v_invitation.status = 'revoked' then
    raise exception 'revoked_invitation';
  end if;

  if v_invitation.status <> 'pending' then
    raise exception 'invalid_invitation';
  end if;

  if v_invitation.expires_at <= now() then
    update public.invitation
    set status = 'expired',
        updated_at = now()
    where id = v_invitation.id;

    raise exception 'expired_invitation';
  end if;

  if lower(v_invitation.email) <> v_user_email then
    raise exception 'email_mismatch';
  end if;

  select id
  into v_existing_member_id
  from public.merchant_member
  where merchant_account_id = v_invitation.merchant_account_id
    and user_id = auth.uid()
  limit 1;

  if v_existing_member_id is null then
    insert into public.merchant_member (merchant_account_id, user_id, role)
    values (v_invitation.merchant_account_id, auth.uid(), v_invitation.role);
  end if;

  update public.invitation
  set status = 'accepted',
      accepted_at = now(),
      accepted_by = auth.uid(),
      updated_at = now()
  where id = v_invitation.id;

  insert into public.audit_log (
    merchant_account_id,
    actor_user_id,
    action,
    resource_type,
    resource_id,
    payload
  )
  values (
    v_invitation.merchant_account_id,
    auth.uid(),
    'invite_accepted',
    'invitation',
    v_invitation.id,
    jsonb_build_object('role', v_invitation.role, 'email', v_invitation.email)
  );

  return jsonb_build_object(
    'ok', true,
    'merchant_account_id', v_invitation.merchant_account_id,
    'role', v_invitation.role
  );
end;
$$;

revoke all on function public.accept_invitation(text) from public, anon;
grant execute on function public.accept_invitation(text) to authenticated;
