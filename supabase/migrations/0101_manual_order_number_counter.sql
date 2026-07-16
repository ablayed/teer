-- 0101 — Numérotation lisible et concurrent-safe des commandes créées manuellement.
--
-- Les numéros Shopify restent inchangés (ex. #2921). Les nouvelles commandes manuelles
-- utilisent M-<n>, avec un compteur indépendant par marchand. Les anciens MAN-<timestamp>
-- ne sont ni lus ni modifiés par cette migration.

create table public.manual_order_number_counter (
  merchant_account_id uuid primary key
    references public.merchant_account(id) on delete cascade,
  next_value bigint not null default 1 check (next_value > 0)
);

-- Cette table est une primitive interne : aucun client ne peut la lire ni la modifier
-- directement. La seule surface publique est la fonction de réservation ci-dessous.
alter table public.manual_order_number_counter enable row level security;
alter table public.manual_order_number_counter force row level security;
revoke all on table public.manual_order_number_counter from public, anon, authenticated;

-- Réserve atomiquement le prochain numéro d'une commande manuelle pour un marchand.
-- Les rôles autorisés sont exactement ceux de createManualOrderAction : owner, manager,
-- agent. La vérification du tenant est faite dans la fonction SECURITY DEFINER avant
-- tout accès à la table interne ; un appelant ne peut donc jamais avancer le compteur
-- d'un autre marchand.
create function public.reserve_manual_order_number(p_merchant_account_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_reserved_value bigint;
begin
  v_role := public.current_member_role(p_merchant_account_id);

  if v_role is null or v_role not in ('owner', 'manager', 'agent') then
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

  insert into public.manual_order_number_counter as counter (
    merchant_account_id,
    next_value
  )
  values (p_merchant_account_id, 2)
  on conflict (merchant_account_id) do update
    set next_value = counter.next_value + 1
  returning next_value - 1 into v_reserved_value;

  return 'M-' || v_reserved_value::text;
end;
$$;

revoke all on function public.reserve_manual_order_number(uuid) from public, anon;
grant execute on function public.reserve_manual_order_number(uuid) to authenticated;
