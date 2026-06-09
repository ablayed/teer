-- ============================================================
-- 0045 : Phase 9 - RPC liste commandes paginee + compteurs vues
-- ============================================================
-- Contexte :
--   * 0044 a materialise les cles de tri exactes de la liste commandes :
--       - sort_at        = coalesce(created_at_shopify, created_at)
--       - next_action_at = coalesce(next_contact_at, created_at_shopify, created_at)
--   * L'UI actuelle charge tout, puis applique en memoire :
--       - le predicat des 8 vues
--       - la recherche (nom / produit / telephone SN avec fallbacks)
--       - le tri (DESC general, ASC sur "Tentee / A rappeler")
--       - les compteurs de chips
--   * Objectif : deplacer EXACTEMENT cette algebre en base pour servir
--     le refactor cursor-based du code applicatif, sans changer le sens.
--
-- Contraintes de compatibilite :
--   * Les predicats de vues doivent rester byte-identiques a
--     lib/domain/order-saved-views.ts.
--   * La recherche doit rester byte-identique a lib/orders/search.ts :
--       - helper public.sn_phone_e164 re-utilise
--       - fallback digitsOnly substring preserve
--       - fallback "national digits" preserve
--   * Seule difference intentionnelle future cote app : tie-breaker stable
--     sur id (ASC pour callback, DESC sinon) quand la cle de tri est egale.
--
-- Aucun nouveau schema metier : seulement 2 RPC SECURITY INVOKER.
-- Elles restent scopees par RLS + garde membre explicite.
-- ============================================================

create or replace function public.list_orders_paginated(
  p_merchant_id uuid,
  p_view text default 'toutes',
  p_search text default null,
  p_cursor_sort timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 25
)
returns table (
  id uuid,
  customer_id uuid,
  order_number text,
  total_amount numeric,
  currency text,
  cod_status text,
  order_state text,
  call_state text,
  delivery_state text,
  cash_state text,
  items_summary jsonb,
  shipping_address jsonb,
  created_at timestamptz,
  created_at_shopify timestamptz,
  next_contact_at timestamptz,
  scheduled_for timestamptz,
  source text,
  sort_at timestamptz,
  next_action_at timestamptz,
  customer_full_name text,
  customer_phone text
)
language sql
stable
security invoker
set search_path = public
as $$
  with params as (
    select
      p_merchant_id as merchant_id,
      coalesce(nullif(btrim(p_view), ''), 'toutes') as view_id,
      lower(btrim(coalesce(p_search, ''))) as search_text,
      regexp_replace(coalesce(p_search, ''), '\D', '', 'g') as search_digits,
      public.sn_phone_e164(coalesce(p_search, '')) as search_phone,
      p_cursor_sort as cursor_sort,
      p_cursor_id as cursor_id,
      least(greatest(p_limit, 1), 100) as page_limit,
      public.current_member_role(p_merchant_id) is not null as can_access,
      timezone('Africa/Dakar', now())::date as today_dakar
  ),
  scoped_orders as (
    select
      o.id,
      o.customer_id,
      o.order_number,
      o.total_amount,
      o.currency,
      o.cod_status,
      o.order_state,
      o.call_state,
      o.delivery_state,
      o.cash_state,
      o.items_summary,
      o.shipping_address,
      o.created_at,
      o.created_at_shopify,
      o.next_contact_at,
      o.scheduled_for,
      o.source,
      o.sort_at,
      o.next_action_at,
      c.full_name as customer_full_name,
      c.phone as customer_phone,
      p.view_id,
      p.search_text,
      p.search_digits,
      p.search_phone,
      p.cursor_sort,
      p.cursor_id,
      p.page_limit,
      p.today_dakar
    from params p
    join public.orders o
      on o.merchant_account_id = p.merchant_id
    left join public.customer c
      on c.id = o.customer_id
     and c.merchant_account_id = p.merchant_id
    where p.can_access
      and case p.view_id
        when 'toutes' then true
        when 'a-appeler' then o.order_state = 'open' and o.call_state = 'to_call'
        when 'tentee-a-rappeler' then o.order_state = 'open' and o.call_state = 'callback'
        when 'confirmee' then
          o.order_state = 'open'
          and o.call_state = 'validated'
          and o.delivery_state in ('unassigned', 'scheduled')
        when 'a-livrer-aujourdhui' then
          o.delivery_state in ('scheduled', 'assigned', 'out_for_delivery')
          and timezone('Africa/Dakar', o.scheduled_for)::date = p.today_dakar
        when 'cash-a-remettre' then o.cash_state = 'collected'
        when 'annulees' then o.order_state = 'cancelled'
        when 'retours' then o.order_state = 'returned'
        else true
      end
      and (
        p.search_text = ''
        or lower(coalesce(c.full_name, '')) like '%' || p.search_text || '%'
        or public.order_items_search_text(o.items_summary) like '%' || p.search_text || '%'
        or (
          c.phone is not null
          and (
            (
              p.search_phone is not null
              and lower(coalesce(public.sn_phone_e164(c.phone), c.phone)) = lower(p.search_phone)
            )
            or (
              p.search_digits = ''
              and lower(coalesce(public.sn_phone_e164(c.phone), c.phone))
                like '%' || p.search_text || '%'
            )
            or (
              p.search_digits <> ''
              and (
                regexp_replace(coalesce(public.sn_phone_e164(c.phone), c.phone), '\D', '', 'g')
                  like '%' || p.search_digits || '%'
                or coalesce(
                  case
                    when public.sn_phone_e164(c.phone) is not null
                      then substr(public.sn_phone_e164(c.phone), 5)
                    else right(regexp_replace(c.phone, '\D', '', 'g'), 9)
                  end,
                  ''
                ) like '%' || p.search_digits || '%'
              )
            )
          )
        )
      )
  )
  select
    s.id,
    s.customer_id,
    s.order_number,
    s.total_amount,
    s.currency,
    s.cod_status,
    s.order_state,
    s.call_state,
    s.delivery_state,
    s.cash_state,
    s.items_summary,
    s.shipping_address,
    s.created_at,
    s.created_at_shopify,
    s.next_contact_at,
    s.scheduled_for,
    s.source,
    s.sort_at,
    s.next_action_at,
    s.customer_full_name,
    s.customer_phone
  from scoped_orders s
  where case
    when s.view_id = 'tentee-a-rappeler' then
      s.cursor_sort is null
      or s.cursor_id is null
      or (s.next_action_at, s.id) > (s.cursor_sort, s.cursor_id)
    else
      s.cursor_sort is null
      or s.cursor_id is null
      or (s.sort_at, s.id) < (s.cursor_sort, s.cursor_id)
  end
  order by
    case when s.view_id = 'tentee-a-rappeler' then s.next_action_at end asc nulls last,
    case when s.view_id = 'tentee-a-rappeler' then s.id end asc nulls last,
    case when s.view_id <> 'tentee-a-rappeler' then s.sort_at end desc nulls last,
    case when s.view_id <> 'tentee-a-rappeler' then s.id end desc nulls last
  limit (select page_limit from params);
$$;

revoke all on function public.list_orders_paginated(
  uuid,
  text,
  text,
  timestamptz,
  uuid,
  integer
) from public, anon;

grant execute on function public.list_orders_paginated(
  uuid,
  text,
  text,
  timestamptz,
  uuid,
  integer
) to authenticated;

create or replace function public.orders_view_counts(
  p_merchant_id uuid,
  p_search text default null
)
returns table (
  toutes bigint,
  a_appeler bigint,
  tentee_a_rappeler bigint,
  confirmee bigint,
  a_livrer_aujourdhui bigint,
  cash_a_remettre bigint,
  annulees bigint,
  retours bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with params as (
    select
      p_merchant_id as merchant_id,
      lower(btrim(coalesce(p_search, ''))) as search_text,
      regexp_replace(coalesce(p_search, ''), '\D', '', 'g') as search_digits,
      public.sn_phone_e164(coalesce(p_search, '')) as search_phone,
      public.current_member_role(p_merchant_id) is not null as can_access,
      timezone('Africa/Dakar', now())::date as today_dakar
  ),
  searched_orders as (
    select
      o.order_state,
      o.call_state,
      o.delivery_state,
      o.cash_state,
      o.items_summary,
      o.scheduled_for,
      c.full_name as customer_full_name,
      c.phone as customer_phone
    from params p
    join public.orders o
      on o.merchant_account_id = p.merchant_id
    left join public.customer c
      on c.id = o.customer_id
     and c.merchant_account_id = p.merchant_id
    where p.can_access
      and (
        p.search_text = ''
        or lower(coalesce(c.full_name, '')) like '%' || p.search_text || '%'
        or public.order_items_search_text(o.items_summary) like '%' || p.search_text || '%'
        or (
          c.phone is not null
          and (
            (
              p.search_phone is not null
              and lower(coalesce(public.sn_phone_e164(c.phone), c.phone)) = lower(p.search_phone)
            )
            or (
              p.search_digits = ''
              and lower(coalesce(public.sn_phone_e164(c.phone), c.phone))
                like '%' || p.search_text || '%'
            )
            or (
              p.search_digits <> ''
              and (
                regexp_replace(coalesce(public.sn_phone_e164(c.phone), c.phone), '\D', '', 'g')
                  like '%' || p.search_digits || '%'
                or coalesce(
                  case
                    when public.sn_phone_e164(c.phone) is not null
                      then substr(public.sn_phone_e164(c.phone), 5)
                    else right(regexp_replace(c.phone, '\D', '', 'g'), 9)
                  end,
                  ''
                ) like '%' || p.search_digits || '%'
              )
            )
          )
        )
      )
  )
  select
    count(*) as toutes,
    count(*) filter (
      where order_state = 'open'
        and call_state = 'to_call'
    ) as a_appeler,
    count(*) filter (
      where order_state = 'open'
        and call_state = 'callback'
    ) as tentee_a_rappeler,
    count(*) filter (
      where order_state = 'open'
        and call_state = 'validated'
        and delivery_state in ('unassigned', 'scheduled')
    ) as confirmee,
    count(*) filter (
      where delivery_state in ('scheduled', 'assigned', 'out_for_delivery')
        and timezone('Africa/Dakar', scheduled_for)::date = (select today_dakar from params)
    ) as a_livrer_aujourdhui,
    count(*) filter (
      where cash_state = 'collected'
    ) as cash_a_remettre,
    count(*) filter (
      where order_state = 'cancelled'
    ) as annulees,
    count(*) filter (
      where order_state = 'returned'
    ) as retours
  from searched_orders;
$$;

revoke all on function public.orders_view_counts(uuid, text) from public, anon;
grant execute on function public.orders_view_counts(uuid, text) to authenticated;
