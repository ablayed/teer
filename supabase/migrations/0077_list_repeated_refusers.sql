-- 0077 — Analyses (Bug 1, fix de fond) : RPC list_repeated_refusers.
--
-- Contexte : /analyses renvoyait 503 sur un compte à ~1000 commandes. L'étape A
--   (quick win) a supprimé la pagination séquentielle `while(true)` côté TS, mais le
--   coût algorithmique intra-appel subsiste : list_customer_reliability score TOUS les
--   clients du tenant via `cross join lateral get_customer_reliability` (0014), soit
--   O(N_clients) scorings pondérés (transitions + call_log) pour ne garder au final que
--   les clients à refused_count >= 2 (tableau repeatedRefusers de computeLossAnalytics).
--
-- Fix de fond : on identifie D'ABORD, à coût faible, les clients à >= 2 commandes REFUSEE
--   (simple group by sur orders), PUIS on ne score QUE ceux-là. La lateral passe de
--   O(N_clients) à O(N_refuseurs), avec N_refuseurs << N_clients.
--
-- Sémantique refused_count IDENTIQUE à get_customer_reliability (0014:63) :
--   count(o.id) filter (where o.cod_status = 'REFUSEE'), sur TOUTES les commandes du
--   client (aucune borne temporelle), scopé merchant_account_id = p_merchant_id.
--   Le CTE `refusers` réutilise exactement ce filtre → tout client scoré a bien
--   refused_count >= 2 (garanti cohérent avec le score renvoyé par la fonction).
--
-- Contrat de sortie = exactement les 6 champs consommés par le tableau repeatedRefusers
--   (metrics.ts LossAnalyticsReliability -> LossAnalyticsRepeatedRefuser) :
--   customer_id, full_name, order_count, refused_count, score, tier.
--   Tri déterministe (refused_count desc, score asc, full_name asc, customer_id) =
--   miroir du tri TS (refusedCount desc, score asc) + tiebreakers stables pour éviter
--   tout diff visuel aléatoire. Bornage p_limit défensif (1..100).
--
-- security invoker (lit via les policies RLS de l'appelant, comme get_customer_reliability
--   et list_customer_reliability) ; filtre tenant merchant_account_id explicite.
--
-- Index : aucun nouvel index requis. Le CTE `refusers` (merchant_account_id + cod_status,
--   group by customer_id) est couvert par orders_merchant_customer_cod_idx (0014 :
--   orders (merchant_account_id, customer_id, cod_status) where customer_id is not null).
--   get_customer_reliability réutilise les index 0014 (orders_customer_idx,
--   order_state_transition_order_to_actor_idx, call_log_order_outcome_created_idx).

create or replace function public.list_repeated_refusers(
  p_merchant_id uuid,
  p_limit integer default 100
)
returns table (
  customer_id uuid,
  full_name text,
  order_count integer,
  refused_count integer,
  score integer,
  tier text
)
language sql
stable
security invoker
set search_path = public
as $$
  with refusers as (
    -- Clients du tenant à >= 2 commandes REFUSEE (même sémantique que
    -- get_customer_reliability.refused_count). Pré-filtre à coût faible : on ne
    -- scorera que ces clients, pas tout le tenant.
    select o.customer_id
    from public.orders o
    where o.merchant_account_id = p_merchant_id
      and o.customer_id is not null
      and o.cod_status = 'REFUSEE'
    group by o.customer_id
    having count(*) >= 2
  ),
  scored as (
    select r.*
    from refusers rf
    cross join lateral public.get_customer_reliability(p_merchant_id, rf.customer_id) r
  )
  select
    s.customer_id,
    s.full_name,
    s.order_count,
    s.refused_count,
    s.score,
    s.tier
  from scored s
  order by
    s.refused_count desc,
    s.score asc,
    s.full_name asc nulls last,
    s.customer_id
  limit least(greatest(coalesce(p_limit, 100), 1), 100);
$$;

revoke all on function public.list_repeated_refusers(uuid, integer) from public, anon;
grant execute on function public.list_repeated_refusers(uuid, integer) to authenticated;
