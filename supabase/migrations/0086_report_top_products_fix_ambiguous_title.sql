-- 0086 — Fix-forward de get_report_top_products (0085) : « column reference "title" is
-- ambiguous » à l'exécution, découvert par les tests RLS (tests/rls/report-non-cash-
-- aggregates.rls.test.ts) avant merge.
--
-- Cause : `returns table (title text, quantity bigint, amount_minor bigint)` déclare
-- implicitement `title`/`quantity`/`amount_minor` comme variables PL/pgSQL dans le corps de la
-- fonction (même mécanisme que des paramètres OUT). La CTE `priced` référençait `title`/
-- `quantity` SANS qualifier leur source (`from items`), ce qui rend la référence ambiguë entre
-- la variable PL/pgSQL et la colonne de la CTE `items` du même nom — Postgres refuse l'appel.
-- Les deux autres RPC de 0085 (get_report_status_breakdown, get_report_revenue_by_day) ne sont
-- pas concernées : elles ne référencent jamais leurs colonnes de sortie sans qualification.
--
-- Fix : qualifier explicitement `items.title`/`items.quantity`/`items.price_minor_raw`/
-- `items.price_raw` dans la CTE `priced`, et remplacer les alias `amount_minor`/`quantity` de
-- l'ORDER BY final par les expressions d'agrégation complètes (`sum(...)`) pour éviter la même
-- ambiguïté avec les variables de sortie. Formule et contrat de sortie strictement inchangés —
-- seule la référence de colonnes est corrigée. `create or replace function` : signature
-- identique, pas de nouveau grant nécessaire.

create or replace function public.get_report_top_products(
  p_merchant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_shop_id uuid default null
)
returns table (
  title text,
  quantity bigint,
  amount_minor bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  v_role := public.current_member_role(p_merchant_id);

  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'forbidden'
      using errcode = '42501';
  end if;

  return query
  with items as (
    select
      case
        when jsonb_typeof(elem -> 'title') = 'string'
             and length(trim(both from (elem ->> 'title'))) > 0
          then trim(both from (elem ->> 'title'))
        else 'Produit'
      end as title,
      greatest(
        round(
          case when jsonb_typeof(elem -> 'quantity') = 'number'
               then (elem ->> 'quantity')::numeric else 0 end
        ),
        0
      ) as quantity,
      case when jsonb_typeof(elem -> 'price_minor') = 'number'
           then (elem ->> 'price_minor')::numeric else 0 end as price_minor_raw,
      case when jsonb_typeof(elem -> 'price') = 'number'
           then (elem ->> 'price')::numeric else 0 end as price_raw
    from public.orders o
    cross join lateral jsonb_array_elements(o.items_summary) as elem
    where o.merchant_account_id = p_merchant_id
      and o.created_at >= p_from
      and o.created_at <= p_to
      and (p_shop_id is null or o.shop_id = p_shop_id)
      and jsonb_typeof(o.items_summary) = 'array'
      and jsonb_typeof(elem) = 'object'
  ),
  priced as (
    select
      items.title,
      items.quantity,
      round(case when items.price_minor_raw > 0 then items.price_minor_raw else items.price_raw end)
        as item_price_minor
    from items
  )
  select
    p.title,
    sum(p.quantity)::bigint as quantity,
    sum(p.quantity * p.item_price_minor)::bigint as amount_minor
  from priced p
  group by p.title
  order by sum(p.quantity * p.item_price_minor) desc, sum(p.quantity) desc
  limit 10;
end;
$$;
