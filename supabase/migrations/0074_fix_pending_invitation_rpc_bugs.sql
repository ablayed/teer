create or replace function public.accept_pending_invitation_by_email(p_invitation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invitation public.invitation%rowtype;
  v_user_email text;
  v_existing_member_id uuid;
  v_existing_other_account_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

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
  where id = p_invitation_id
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
    where public.invitation.id = v_invitation.id;

    raise exception 'expired_invitation';
  end if;

  if lower(v_invitation.email) <> v_user_email then
    raise exception 'email_mismatch';
  end if;

  select merchant_member.merchant_account_id
  into v_existing_other_account_id
  from public.merchant_member
  where merchant_member.user_id = auth.uid()
    and merchant_member.merchant_account_id <> v_invitation.merchant_account_id
  limit 1;

  if v_existing_other_account_id is not null then
    raise exception 'already_has_organization';
  end if;

  select merchant_member.id
  into v_existing_member_id
  from public.merchant_member
  where merchant_member.merchant_account_id = v_invitation.merchant_account_id
    and merchant_member.user_id = auth.uid()
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
  where public.invitation.id = v_invitation.id;

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

revoke all on function public.accept_pending_invitation_by_email(uuid) from public, anon;
grant execute on function public.accept_pending_invitation_by_email(uuid) to authenticated;

create or replace function public.list_my_pending_invitations()
returns table(
  id uuid,
  merchant_account_id uuid,
  org_name text,
  role text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_email text;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  select lower(auth_users.email)
  into v_user_email
  from auth.users as auth_users
  where auth_users.id = auth.uid();

  if v_user_email is null then
    raise exception 'user_email_not_found';
  end if;

  return query
  select
    inv.id,
    inv.merchant_account_id,
    account.name as org_name,
    inv.role,
    inv.expires_at
  from public.invitation as inv
  join public.merchant_account as account
    on account.id = inv.merchant_account_id
  where lower(inv.email) = v_user_email
    and inv.status = 'pending'
    and inv.expires_at > now()
  order by inv.created_at asc, inv.id asc;
end;
$$;

revoke all on function public.list_my_pending_invitations() from public, anon;
grant execute on function public.list_my_pending_invitations() to authenticated;
