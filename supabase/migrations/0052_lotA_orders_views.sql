-- ============================================================
-- 0052 : Lot A - refonte de la barre de vues Commandes
-- ============================================================
-- Contexte :
--   * 0045 a deplace l'algebre des 8 vues + compteurs de chips dans deux RPC
--     SQL (list_orders_paginated / orders_view_counts), keyset-paginees.
--   * Lot A change la LISTE des vues affichees (pur affichage, le moteur de
--     transitions ne bouge pas) :
--       - « Programmer »            = id `confirmee` CONSERVE (deep-links), label
--         change cote app, predicat INCHANGE.
--       - « En cours de livraison » = NOUVEL id `en-livraison`
--         delivery_state ∈ {scheduled, assigned, out_for_delivery} (SANS date).
--       - « Valide »                = NOUVEL id `valide`  order_state = 'completed'.
--       - « Annulees / Retours »    = NOUVEL id `annulees-retours`
--         order_state ∈ {cancelled, returned} (affichage groupe ; les deux
--         order_state restent DISTINCTS en base, les analytics en dependent).
--   * SUPPRIMES de la barre + des compteurs : `a-livrer-aujourdhui`,
--     `cash-a-remettre`, `annulees`, `retours`. Le cash reste gere dans
--     Finances/Livreurs (non touches ici).
--
-- Compatibilite :
--   * La recherche reste BYTE-IDENTIQUE a 0045 / lib/orders/search.ts
--     (helper public.sn_phone_e164 + fallbacks digits/national preserves).
--   * Le tie-breaker keyset est inchange (ASC sur `tentee-a-rappeler`,
--     DESC sinon).
--   * Plus aucune vue ne depend de la date du jour → le calcul `today_dakar`
--     est retire des deux RPC.
--
-- Aucun nouveau schema metier : seulement 2 RPC SECURITY INVOKER, scopees par
-- RLS + garde membre explicite (current_member_role non NULL).
-- orders_view_counts CHANGE de type de retour (colonnes) → DROP puis CREATE.
-- list_orders_paginated garde la meme signature ET les memes colonnes de
-- sortie → CREATE OR REPLACE suffit.
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

-- orders_view_counts change de colonnes de retour → DROP obligatoire avant CREATE.
drop function if exists public.orders_view_counts(uuid, text);

create function public.orders_view_counts(
  p_merchant_id uuid,
  p_search text default null
)
returns table (
  toutes bigint,
  a_appeler bigint,
  tentee_a_rappeler bigint,
  confirmee bigint,
  en_livraison bigint,
  valide bigint,
  annulees_retours bigint
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
      public.current_member_role(p_merchant_id) is not null as can_access
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
    ) as en_livraison,
    count(*) filter (
      where order_state = 'completed'
    ) as valide,
    count(*) filter (
      where order_state in ('cancelled', 'returned')
    ) as annulees_retours
  from searched_orders;
$$;

revoke all on function public.orders_view_counts(uuid, text) from public, anon;
grant execute on function public.orders_view_counts(uuid, text) to authenticated;
