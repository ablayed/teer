-- ============================================================
-- 0060 : phase11 — assigned_driver_id dans la liste paginée des commandes
-- ============================================================
-- La vue « À livrer » doit afficher « Affecté à {livreur} » + un picker de
-- réassignation par ligne. La RPC list_orders_paginated (0052) ne renvoyait pas
-- assigned_driver_id → on l'ajoute au RETURNS TABLE et aux deux SELECT.
--
-- Le NOM du livreur est résolu côté client depuis la liste des livreurs actifs
-- déjà chargée (aucune jointure driver ici) ; seule la clé assigned_driver_id
-- manque. Changement de colonnes de retour ⇒ DROP obligatoire avant CREATE
-- (create or replace ne peut pas modifier le type de retour). Corps reproduit
-- À L'IDENTIQUE de 0052, + assigned_driver_id (RETURNS TABLE, scoped_orders,
-- SELECT final). Re-grant identique (le DROP réinitialise les privilèges).
-- ============================================================

drop function if exists public.list_orders_paginated(
  uuid, text, text, timestamptz, uuid, integer
);

create function public.list_orders_paginated(
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
  assigned_driver_id uuid,
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
      public.current_member_role(p_merchant_id) is not null as can_access
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
      o.assigned_driver_id,
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
      p.page_limit
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
        when 'en-livraison' then
          o.delivery_state in ('scheduled', 'assigned', 'out_for_delivery')
        when 'valide' then o.order_state = 'completed'
        when 'annulees-retours' then o.order_state in ('cancelled', 'returned')
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
    s.assigned_driver_id,
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
