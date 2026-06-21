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
  if exists (
    select 1
    from public.invitation
    where lower(email) = lower(new.email)
      and status = 'pending'
      and expires_at > now()
  ) then
    return new;
  end if;

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

create or replace function public.enforce_single_organization_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.merchant_member
    where user_id = new.user_id
      and merchant_account_id <> new.merchant_account_id
  ) then
    raise exception 'already_has_organization' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_single_organization_membership() from public, anon, authenticated;

drop trigger if exists merchant_member_single_org_guard on public.merchant_member;

create trigger merchant_member_single_org_guard
  before insert on public.merchant_member
  for each row execute function public.enforce_single_organization_membership();

create or replace function public.accept_invitation(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token_hash bytea;
  v_invitation public.invitation%rowtype;
  v_user_email text;
  v_existing_member_id uuid;
  v_existing_other_account_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  v_token_hash := extensions.digest(p_token, 'sha256');

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

  select merchant_account_id
  into v_existing_other_account_id
  from public.merchant_member
  where user_id = auth.uid()
    and merchant_account_id <> v_invitation.merchant_account_id
  limit 1;

  if v_existing_other_account_id is not null then
    raise exception 'already_has_organization';
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
