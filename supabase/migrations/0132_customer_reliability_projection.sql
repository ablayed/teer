-- ============================================================================
-- 0132 — Projection persistée de la fiabilité client
-- ============================================================================
-- PROBLÈME MESURÉ (production, compte pilote : 1371 clients, 1456 commandes)
--
--   list_store_customer_reliability (0128) trie sur des colonnes PRODUITES par un
--   `cross join lateral get_store_customer_reliability(...)`. PostgreSQL doit donc
--   évaluer la fonction par client AVANT de pouvoir trier, et le `LIMIT 50`
--   n'élague rien. Plan réel relevé en production (rôle superuser, RLS contournée,
--   cache chaud — donc un PLANCHER optimiste) :
--
--     Limit (actual time=2948.123..2948.133 rows=50)
--       -> Sort (Sort Key: r.full_name, r.customer_id)
--            -> Nested Loop (actual rows=1371)
--                 -> Seq Scan on customer c (actual rows=1371)
--                 -> Function Scan on get_store_customer_reliability r
--                      (actual time=2.115..2.115 rows=1 loops=1371)
--                      Buffers: shared hit=1773409
--     Execution Time: 2948.452 ms
--
--   Sous une session `authenticated` les policies RLS de customer / orders /
--   order_state_transition / call_log / merchant_member s'ajoutent à chacune des
--   1371 boucles, d'où le dépassement de la durée de fonction (503) constaté sur
--   `/clients` pour le gros compte, et l'absence d'exception Sentry (timeout, pas
--   crash). La forme fautive est ANTÉRIEURE à la Phase 1 : `list_customer_reliability`
--   (0049 ligne 266) a exactement le même `cross join lateral` + `order by` latéral.
--
-- CE QUI EST MATÉRIALISÉ, ET POURQUOI CE N'EST PAS LE SCORE FINAL
--
--   Le score est TEMPOREL : chaque commande / appel est pondéré par
--   power(0.5, âge_jours / 180) évalué à `now()`. Un score figé serait donc faux
--   dès le lendemain, SANS AUCUNE ÉCRITURE — aucune invalidation événementielle ne
--   pourrait le rattraper, et « Risques en haut » changerait silencieusement de sens
--   entre deux rafraîchissements.
--
--   On matérialise donc les seules quantités STRICTEMENT INVARIANTES dans le temps,
--   c'est-à-dire le minimum permettant de reproduire le résultat courant :
--     * les compteurs (order_count, delivered_count, refused_count, cancelled_count)
--       et delivered_lifetime ;
--     * les sommes de décroissance ANCRÉES sur une époque fixe T0.
--
--   Identité exploitée : 0.5^((t - ts)/180) = 0.5^((t - T0)/180) · 0.5^(-(ts - T0)/180).
--   Le second facteur ne dépend que de la ligne → il est sommable et stockable ;
--   le premier ne dépend que de l'instant de lecture → il est appliqué en SQL au
--   moment du read. Le résultat est donc EXACT à tout instant, pas approché, et la
--   projection n'a besoin d'être rafraîchie que sur ÉVÉNEMENT D'ÉCRITURE.
--
--   Conséquence assumée et documentée : le tri par risque ne peut pas s'appuyer sur
--   un index sur le score (il dépend de l'instant de lecture). Il devient un tri
--   ENSEMBLISTE sur la projection — une passe d'arithmétique pure sur une table
--   étroite, sans appel de fonction ni sous-requête corrélée — donc globalement
--   correct sur TOUS les clients filtrés, pas seulement sur la page courante.
--
-- INVALIDATION PAR TRIGGERS, ET NON PAR CÂBLAGE TS
--
--   Les entrées du score sont écrites par 19 chemins distincts : 11 fonctions SQL
--   vivantes (transition_order, reassign_order_driver, replace_order_cart,
--   replace_shopify_order_cart, reduce_order_cart_post_assignment, set_order_note,
--   redact_shopify_customer_copies, execute_shopify_pcd_retention, accept_invitation,
--   accept_pending_invitation_by_email, handle_new_user) et 8 sites TS, dont des
--   chemins service-role qui contournent RLS. Câbler l'invalidation côté TS en
--   manquerait structurellement la majorité et se périmerait au prochain lot.
--   Les triggers de niveau instruction posés ici couvrent les 5 TABLES sources :
--   l'exhaustivité devient une propriété du schéma, pas d'une liste à maintenir.
--
-- CE LOT NE TOUCHE PAS get_store_customer_reliability : elle reste l'implémentation
-- de référence indépendante contre laquelle la parité de la projection est testée.
-- ============================================================================

-- ── 1. Époque et facteurs de décroissance ───────────────────────────────────
-- T0 figée : toute modification de cette constante invaliderait toutes les
-- valeurs ancrées déjà stockées. Ne jamais la changer sans rebuild complet.
create or replace function public.customer_reliability_decay_epoch()
returns timestamptz
language sql
immutable
parallel safe
as $$
  select timestamptz '2020-01-01 00:00:00+00';
$$;

-- Contribution invariante d'une ligne horodatée `p_ts` : 0.5^(-(ts - T0)/180j).
create or replace function public.customer_reliability_decay_anchor(p_ts timestamptz)
returns numeric
language sql
immutable
parallel safe
as $$
  select power(
    0.5,
    (- extract(epoch from (p_ts - public.customer_reliability_decay_epoch())) / 86400.0) / 180.0
  );
$$;

-- Facteur commun à l'instant de lecture : 0.5^((t - T0)/180j).
create or replace function public.customer_reliability_decay_factor(p_at timestamptz)
returns numeric
language sql
immutable
parallel safe
as $$
  select power(
    0.5,
    (extract(epoch from (p_at - public.customer_reliability_decay_epoch())) / 86400.0) / 180.0
  );
$$;

revoke all on function public.customer_reliability_decay_epoch() from public, anon;
revoke all on function public.customer_reliability_decay_anchor(timestamptz) from public, anon;
revoke all on function public.customer_reliability_decay_factor(timestamptz) from public, anon;
grant execute on function public.customer_reliability_decay_epoch() to authenticated, service_role;
grant execute on function public.customer_reliability_decay_anchor(timestamptz) to authenticated, service_role;
grant execute on function public.customer_reliability_decay_factor(timestamptz) to authenticated, service_role;

-- ── 2. Cible de clé étrangère composite ─────────────────────────────────────
-- `id` est déjà la PK de customer, donc ce triplet est trivialement unique ; la
-- contrainte n'existe que pour servir de cible à la FK composite ci-dessous, qui
-- garantit qu'une ligne de projection ne peut pas prétendre appartenir à une
-- boutique où son client n'est pas.
alter table public.customer
  drop constraint if exists customer_tenant_shop_id_key;
alter table public.customer
  add constraint customer_tenant_shop_id_key
  unique (merchant_account_id, shop_id, id);

-- ── 3. Table de projection ──────────────────────────────────────────────────
create table if not exists public.customer_reliability_projection (
  merchant_account_id uuid not null,
  shop_id uuid not null,
  customer_id uuid not null,
  order_count integer not null default 0,
  delivered_count integer not null default 0,
  refused_count integer not null default 0,
  cancelled_count integer not null default 0,
  delivered_lifetime numeric not null default 0,
  delivered_anchor numeric not null default 0,
  refused_anchor numeric not null default 0,
  confirmed_anchor numeric not null default 0,
  attempts_anchor numeric not null default 0,
  no_response_anchor numeric not null default 0,
  -- Marqueur de fraîcheur : avancé à chaque rafraîchissement. Rend un audit de
  -- péremption possible plus tard, même si la logique d'invalidation d'aujourd'hui
  -- est correcte — une future écriture pourrait la contourner.
  computed_at timestamptz not null default now(),
  constraint customer_reliability_projection_pkey
    primary key (merchant_account_id, shop_id, customer_id),
  constraint customer_reliability_projection_shop_tenant_fk
    foreign key (merchant_account_id, shop_id)
    references public.shop (merchant_account_id, id)
    on delete cascade,
  constraint customer_reliability_projection_customer_fk
    foreign key (merchant_account_id, shop_id, customer_id)
    references public.customer (merchant_account_id, shop_id, id)
    on delete cascade,
  constraint customer_reliability_projection_counts_check
    check (
      order_count >= 0
      and delivered_count >= 0
      and refused_count >= 0
      and cancelled_count >= 0
      and delivered_anchor >= 0
      and refused_anchor >= 0
      and confirmed_anchor >= 0
      and attempts_anchor >= 0
      and no_response_anchor >= 0
    )
);

create index if not exists customer_reliability_projection_staleness_idx
  on public.customer_reliability_projection (merchant_account_id, shop_id, computed_at);

alter table public.customer_reliability_projection enable row level security;
alter table public.customer_reliability_projection force row level security;

-- Lecture réservée aux membres de la boutique. AUCUNE policy d'écriture : les
-- écritures ne passent que par les fonctions SECURITY DEFINER ci-dessous, dont le
-- propriétaire (`postgres`, BYPASSRLS) n'est pas soumis au FORCE RLS. Un client
-- `authenticated` ne peut donc jamais fabriquer ni altérer un score.
drop policy if exists customer_reliability_projection_select
  on public.customer_reliability_projection;
create policy customer_reliability_projection_select
  on public.customer_reliability_projection
  for select to authenticated
  using (
    public.current_member_role(merchant_account_id) is not null
    and public.is_shop_member_of(shop_id)
  );

revoke all on table public.customer_reliability_projection from public, anon, authenticated;
grant select on table public.customer_reliability_projection to authenticated;

-- ── 4. Rafraîchissement unitaire ────────────────────────────────────────────
-- Recalcule intégralement la ligne de projection des clients demandés depuis les
-- tables sources. Idempotent : deux exécutions consécutives donnent le même état.
--
-- Sérialisation : le verrou de la ligne de projection est pris AVANT le calcul des
-- agrégats. En READ COMMITTED chaque instruction prend un instantané neuf, donc
-- l'agrégat qui suit l'obtention du verrou voit les commandes validées par la
-- transaction concurrente qui vient de libérer ce verrou. Sans cette séquence, deux
-- écritures simultanées sur le même client écriraient chacune un compte de 1 là où
-- la vérité est 2 (anomalie réelle, couverte par un test de concurrence).
create or replace function public.refresh_customer_reliability_projection(
  p_customer_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_customer_id uuid;
  v_merchant_id uuid;
  v_shop_id uuid;
  v_refreshed integer := 0;
begin
  if p_customer_ids is null then
    return 0;
  end if;

  -- Ordre déterministe : évite tout interblocage entre deux instructions qui
  -- touchent les mêmes clients dans un ordre différent.
  for v_customer_id in
    select distinct u.id
    from unnest(p_customer_ids) as u(id)
    where u.id is not null
    order by u.id
  loop
    select c.merchant_account_id, c.shop_id
      into v_merchant_id, v_shop_id
      from public.customer c
     where c.id = v_customer_id;

    if v_merchant_id is null then
      continue;
    end if;

    insert into public.customer_reliability_projection (
      merchant_account_id, shop_id, customer_id, computed_at
    )
    values (v_merchant_id, v_shop_id, v_customer_id, v_now)
    on conflict (merchant_account_id, shop_id, customer_id) do nothing;

    perform 1
      from public.customer_reliability_projection p
     where p.merchant_account_id = v_merchant_id
       and p.shop_id = v_shop_id
       and p.customer_id = v_customer_id
       for update;

    update public.customer_reliability_projection p
       set order_count = om.order_count,
           delivered_count = om.delivered_count,
           refused_count = om.refused_count,
           cancelled_count = om.cancelled_count,
           delivered_lifetime = om.delivered_lifetime,
           delivered_anchor = om.delivered_anchor,
           refused_anchor = om.refused_anchor,
           confirmed_anchor = cm.confirmed_anchor,
           attempts_anchor = cm.attempts_anchor,
           no_response_anchor = cm.no_response_anchor,
           computed_at = v_now
      from (
        select
          count(o.id)::integer as order_count,
          count(o.id) filter (where o.cod_status = 'LIVREE')::integer as delivered_count,
          count(o.id) filter (where o.cod_status = 'REFUSEE')::integer as refused_count,
          count(o.id) filter (
            where o.cod_status = 'ANNULEE'
              and exists (
                select 1
                from public.order_state_transition ost
                left join public.merchant_member mm
                  on mm.merchant_account_id = o.merchant_account_id
                 and mm.user_id = ost.actor_user_id
                where ost.order_id = o.id
                  and ost.shop_id = v_shop_id
                  and ost.to_status = 'ANNULEE'
                  and mm.user_id is null
              )
          )::integer as cancelled_count,
          coalesce(sum(o.total_amount) filter (where o.cod_status = 'LIVREE'), 0)::numeric
            as delivered_lifetime,
          coalesce(sum(
            case when o.cod_status = 'LIVREE'
              then public.customer_reliability_decay_anchor(least(o.created_at, v_now))
              else 0 end
          ), 0)::numeric as delivered_anchor,
          coalesce(sum(
            case when o.cod_status = 'REFUSEE'
              then public.customer_reliability_decay_anchor(least(o.created_at, v_now))
              else 0 end
          ), 0)::numeric as refused_anchor
        from public.orders o
        where o.customer_id = v_customer_id
          and o.merchant_account_id = v_merchant_id
          and o.shop_id = v_shop_id
      ) om,
      (
        select
          coalesce(sum(
            case when cl.outcome = 'CONFIRMEE'
              then public.customer_reliability_decay_anchor(least(cl.created_at, v_now))
              else 0 end
          ), 0)::numeric as confirmed_anchor,
          coalesce(sum(
            public.customer_reliability_decay_anchor(least(cl.created_at, v_now))
          ), 0)::numeric as attempts_anchor,
          coalesce(sum(
            case when cl.outcome = 'SANS_REPONSE'
              then public.customer_reliability_decay_anchor(least(cl.created_at, v_now))
              else 0 end
          ), 0)::numeric as no_response_anchor
        from public.orders o
        join public.call_log cl
          on cl.order_id = o.id
         and cl.merchant_account_id = v_merchant_id
         and cl.shop_id = v_shop_id
        where o.customer_id = v_customer_id
          and o.merchant_account_id = v_merchant_id
          and o.shop_id = v_shop_id
      ) cm
     where p.merchant_account_id = v_merchant_id
       and p.shop_id = v_shop_id
       and p.customer_id = v_customer_id;

    v_refreshed := v_refreshed + 1;
  end loop;

  return v_refreshed;
end;
$$;

-- Jamais appelable par une session utilisateur : les triggers l'invoquent en tant
-- que propriétaire. L'exposer permettrait de déclencher des recalculs hors tenant.
revoke all on function public.refresh_customer_reliability_projection(uuid[])
  from public, anon, authenticated;

-- ── 5. Reconstruction complète, par lots ────────────────────────────────────
-- Le backfill ne prend qu'un ACCESS SHARE sur les tables sources (lecture) et
-- n'écrit que dans la table de projection, créée vide par cette migration : il ne
-- peut donc jamais bloquer une écriture marchande. Le découpage en lots borne le
-- travail et la mémoire par instruction, il ne crée pas de transactions séparées
-- (une migration est une transaction unique).
create or replace function public.rebuild_customer_reliability_projection(
  p_batch_size integer default 500
)
returns table (batches integer, customers integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch integer := 0;
  v_total integer := 0;
  v_size integer := least(greatest(coalesce(p_batch_size, 500), 1), 5000);
  v_last uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  v_ids uuid[];
begin
  loop
    select array_agg(c.id order by c.id)
      into v_ids
      from (
        select c2.id
        from public.customer c2
        where c2.id > v_last
        order by c2.id
        limit v_size
      ) c;

    exit when v_ids is null or cardinality(v_ids) = 0;

    v_total := v_total + public.refresh_customer_reliability_projection(v_ids);
    v_batch := v_batch + 1;
    v_last := v_ids[cardinality(v_ids)];
  end loop;

  batches := v_batch;
  customers := v_total;
  return next;
end;
$$;

revoke all on function public.rebuild_customer_reliability_projection(integer)
  from public, anon, authenticated;
grant execute on function public.rebuild_customer_reliability_projection(integer) to service_role;

-- ── 6. Invalidation : triggers de niveau instruction ────────────────────────
-- Niveau instruction + tables de transition : une écriture en masse ne déclenche
-- qu'un rafraîchissement par client concerné, pas un par ligne.

create or replace function public.tg_customer_reliability_from_orders()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  if tg_op = 'INSERT' then
    select array_agg(distinct n.customer_id) into v_ids
      from new_rows n where n.customer_id is not null;
  elsif tg_op = 'DELETE' then
    select array_agg(distinct o.customer_id) into v_ids
      from old_rows o where o.customer_id is not null;
  else
    select array_agg(distinct u.customer_id) into v_ids
      from (
        select n.customer_id from new_rows n where n.customer_id is not null
        union
        select o.customer_id from old_rows o where o.customer_id is not null
      ) u;
  end if;

  perform public.refresh_customer_reliability_projection(v_ids);
  return null;
end;
$$;

create or replace function public.tg_customer_reliability_from_call_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  if tg_op = 'INSERT' then
    select array_agg(distinct o.customer_id) into v_ids
      from new_rows n join public.orders o on o.id = n.order_id
     where o.customer_id is not null;
  elsif tg_op = 'DELETE' then
    select array_agg(distinct o.customer_id) into v_ids
      from old_rows d join public.orders o on o.id = d.order_id
     where o.customer_id is not null;
  else
    select array_agg(distinct u.customer_id) into v_ids
      from (
        select o.customer_id from new_rows n join public.orders o on o.id = n.order_id
         where o.customer_id is not null
        union
        select o.customer_id from old_rows d join public.orders o on o.id = d.order_id
         where o.customer_id is not null
      ) u;
  end if;

  perform public.refresh_customer_reliability_projection(v_ids);
  return null;
end;
$$;

-- Seules les transitions vers ANNULEE entrent dans le score (cancelled_count) ;
-- tout autre changement d'état passe par un UPDATE de `orders`, déjà couvert.
create or replace function public.tg_customer_reliability_from_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  if tg_op = 'INSERT' then
    select array_agg(distinct o.customer_id) into v_ids
      from new_rows n join public.orders o on o.id = n.order_id
     where n.to_status = 'ANNULEE' and o.customer_id is not null;
  elsif tg_op = 'DELETE' then
    select array_agg(distinct o.customer_id) into v_ids
      from old_rows d join public.orders o on o.id = d.order_id
     where d.to_status = 'ANNULEE' and o.customer_id is not null;
  else
    select array_agg(distinct u.customer_id) into v_ids
      from (
        select o.customer_id from new_rows n join public.orders o on o.id = n.order_id
         where n.to_status = 'ANNULEE' and o.customer_id is not null
        union
        select o.customer_id from old_rows d join public.orders o on o.id = d.order_id
         where d.to_status = 'ANNULEE' and o.customer_id is not null
      ) u;
  end if;

  perform public.refresh_customer_reliability_projection(v_ids);
  return null;
end;
$$;

-- Un client neuf reçoit sa ligne immédiatement, pour que `computed_at` existe dès
-- l'origine. La vue reste néanmoins tolérante à une ligne absente (LEFT JOIN).
create or replace function public.tg_customer_reliability_from_customer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  select array_agg(n.id) into v_ids from new_rows n;
  perform public.refresh_customer_reliability_projection(v_ids);
  return null;
end;
$$;

-- Entrée non évidente du score : `cancelled_count` ne compte une ANNULEE que si
-- son auteur N'EST PAS membre du compte marchand (annulation client vs annulation
-- interne). Ajouter ou retirer un membre requalifie donc rétroactivement ses
-- annulations passées.
create or replace function public.tg_customer_reliability_from_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  with touched as (
    select r.merchant_account_id, r.user_id
    from (
      select n.merchant_account_id, n.user_id from new_rows n
      union
      select o.merchant_account_id, o.user_id from old_rows o
    ) r
  )
  select array_agg(distinct o.customer_id) into v_ids
    from public.order_state_transition ost
    join public.orders o on o.id = ost.order_id
    join touched t
      on t.merchant_account_id = o.merchant_account_id
     and t.user_id = ost.actor_user_id
   where ost.to_status = 'ANNULEE'
     and o.customer_id is not null;

  perform public.refresh_customer_reliability_projection(v_ids);
  return null;
end;
$$;

-- Le trigger sur merchant_account_id/user_id doit voir les deux tables de
-- transition ; pour INSERT et DELETE on déclare l'autre comme table vide via une
-- fonction dédiée par opération.
create or replace function public.tg_customer_reliability_member_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  select array_agg(distinct o.customer_id) into v_ids
    from public.order_state_transition ost
    join public.orders o on o.id = ost.order_id
    join new_rows n
      on n.merchant_account_id = o.merchant_account_id
     and n.user_id = ost.actor_user_id
   where ost.to_status = 'ANNULEE'
     and o.customer_id is not null;

  perform public.refresh_customer_reliability_projection(v_ids);
  return null;
end;
$$;

create or replace function public.tg_customer_reliability_member_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  select array_agg(distinct o.customer_id) into v_ids
    from public.order_state_transition ost
    join public.orders o on o.id = ost.order_id
    join old_rows d
      on d.merchant_account_id = o.merchant_account_id
     and d.user_id = ost.actor_user_id
   where ost.to_status = 'ANNULEE'
     and o.customer_id is not null;

  perform public.refresh_customer_reliability_projection(v_ids);
  return null;
end;
$$;

drop trigger if exists orders_reliability_insert on public.orders;
create trigger orders_reliability_insert
  after insert on public.orders
  referencing new table as new_rows
  for each statement execute function public.tg_customer_reliability_from_orders();

drop trigger if exists orders_reliability_update on public.orders;
create trigger orders_reliability_update
  after update on public.orders
  referencing new table as new_rows old table as old_rows
  for each statement execute function public.tg_customer_reliability_from_orders();

drop trigger if exists orders_reliability_delete on public.orders;
create trigger orders_reliability_delete
  after delete on public.orders
  referencing old table as old_rows
  for each statement execute function public.tg_customer_reliability_from_orders();

drop trigger if exists call_log_reliability_insert on public.call_log;
create trigger call_log_reliability_insert
  after insert on public.call_log
  referencing new table as new_rows
  for each statement execute function public.tg_customer_reliability_from_call_log();

drop trigger if exists call_log_reliability_update on public.call_log;
create trigger call_log_reliability_update
  after update on public.call_log
  referencing new table as new_rows old table as old_rows
  for each statement execute function public.tg_customer_reliability_from_call_log();

drop trigger if exists call_log_reliability_delete on public.call_log;
create trigger call_log_reliability_delete
  after delete on public.call_log
  referencing old table as old_rows
  for each statement execute function public.tg_customer_reliability_from_call_log();

drop trigger if exists order_state_transition_reliability_insert on public.order_state_transition;
create trigger order_state_transition_reliability_insert
  after insert on public.order_state_transition
  referencing new table as new_rows
  for each statement execute function public.tg_customer_reliability_from_transition();

drop trigger if exists order_state_transition_reliability_update on public.order_state_transition;
create trigger order_state_transition_reliability_update
  after update on public.order_state_transition
  referencing new table as new_rows old table as old_rows
  for each statement execute function public.tg_customer_reliability_from_transition();

drop trigger if exists order_state_transition_reliability_delete on public.order_state_transition;
create trigger order_state_transition_reliability_delete
  after delete on public.order_state_transition
  referencing old table as old_rows
  for each statement execute function public.tg_customer_reliability_from_transition();

drop trigger if exists customer_reliability_insert on public.customer;
create trigger customer_reliability_insert
  after insert on public.customer
  referencing new table as new_rows
  for each statement execute function public.tg_customer_reliability_from_customer();

drop trigger if exists merchant_member_reliability_insert on public.merchant_member;
create trigger merchant_member_reliability_insert
  after insert on public.merchant_member
  referencing new table as new_rows
  for each statement execute function public.tg_customer_reliability_member_insert();

drop trigger if exists merchant_member_reliability_update on public.merchant_member;
create trigger merchant_member_reliability_update
  after update on public.merchant_member
  referencing new table as new_rows old table as old_rows
  for each statement execute function public.tg_customer_reliability_from_member();

drop trigger if exists merchant_member_reliability_delete on public.merchant_member;
create trigger merchant_member_reliability_delete
  after delete on public.merchant_member
  referencing old table as old_rows
  for each statement execute function public.tg_customer_reliability_member_delete();

-- ── 7. Backfill ─────────────────────────────────────────────────────────────
select public.rebuild_customer_reliability_projection(500);

-- Aucune ligne ne doit manquer à la sortie de la migration : échouer bruyamment
-- plutôt que livrer une projection partielle.
do $$
declare
  v_missing bigint;
begin
  select count(*) into v_missing
  from public.customer c
  left join public.customer_reliability_projection p
    on p.merchant_account_id = c.merchant_account_id
   and p.shop_id = c.shop_id
   and p.customer_id = c.id
  where p.customer_id is null;

  if v_missing > 0 then
    raise exception 'customer_reliability_projection_backfill_incomplete rows=%', v_missing;
  end if;
end;
$$;

-- ── 8. Vue de scoring — source unique de l'expression du score ──────────────
-- `security_invoker` : les policies de `customer` et de la projection s'appliquent
-- à l'appelant, comme pour les vues de 0127. Arithmétique pure par ligne, sans
-- appel de fonction ensembliste ni sous-requête corrélée : le planificateur peut
-- donc pousser un LIMIT à travers la vue quand le tri le permet.
--
-- Une ligne de projection absente est traitée comme une activité nulle (tous les
-- compteurs à zéro), ce qui reproduit exactement le comportement de
-- get_store_customer_reliability pour un client sans commande (score 70, « new »)
-- et garantit qu'aucun client ne peut DISPARAÎTRE de la liste à cause d'une
-- projection manquante.
create or replace view public.customer_reliability_scored
with (security_invoker = true)
as
select
  s.merchant_account_id,
  s.shop_id,
  s.customer_id,
  s.full_name,
  s.phone,
  s.decided,
  s.delivered_count,
  s.refused_count,
  s.cancelled_count,
  s.order_count,
  s.delivered_lifetime,
  s.delivered_weighted,
  s.refused_weighted,
  s.confirmed_weighted,
  s.attempts_weighted,
  s.no_response_weighted,
  s.delivery_score,
  s.confirm_score,
  s.final_score as score,
  case
    when s.decided < 3 then 'new'
    when s.final_score >= 75 then 'reliable'
    when s.final_score >= 50 then 'watch'
    else 'risk'
  end as tier,
  (s.decided >= 3 and s.decided < 5) as is_provisional,
  (coalesce(s.confirm_score, 0) >= 0.7 and s.delivery_score < 0.5)
    as flag_confirms_then_refuses,
  (s.attempts_weighted > 0
    and (s.no_response_weighted / s.attempts_weighted) >= 0.5
    and s.delivered_count > 0
    and s.delivery_score >= 0.5) as flag_hard_to_reach,
  (s.cancelled_count >= 3
    and s.order_count > 0
    and (s.cancelled_count::numeric / s.order_count::numeric) > 0.40)
    as flag_cancels_often,
  s.computed_at
from (
  select
    b.*,
    case when b.attempts_weighted = 0 then round(100.0 * b.delivery_score)::integer
      else round(100.0 * ((0.70 * b.delivery_score) + (0.30 * b.confirm_score)))::integer
    end as final_score
  from (
    select
      w.*,
      (w.delivered_count + w.refused_count)::integer as decided,
      ((w.delivered_weighted + (5.0 * 0.70)) /
        (w.delivered_weighted + w.refused_weighted + 5.0))::numeric as delivery_score,
      case when w.attempts_weighted = 0 then null
        else ((w.confirmed_weighted + (3.0 * 0.60)) /
          (w.attempts_weighted + 3.0))::numeric
      end as confirm_score
    from (
      select
        c.merchant_account_id,
        c.shop_id,
        c.id as customer_id,
        c.full_name,
        c.phone,
        coalesce(p.order_count, 0) as order_count,
        coalesce(p.delivered_count, 0) as delivered_count,
        coalesce(p.refused_count, 0) as refused_count,
        coalesce(p.cancelled_count, 0) as cancelled_count,
        coalesce(p.delivered_lifetime, 0)::numeric as delivered_lifetime,
        -- Le facteur de lecture est constant sur toute la requête, et il DOIT être
        -- écrit comme une sous-requête scalaire non corrélée : le planificateur
        -- aplatit les sous-requêtes imbriquées de cette vue, donc toute autre forme
        -- (colonne d'un cross join à une ligne, expression inline) est ré-étendue
        -- dans CHAQUE usage aval de delivery_score / score / tier / flags — mesuré
        -- à ~250 ms sur 1400 clients pour des dizaines de `power(numeric)` par
        -- ligne. Sous cette forme, PostgreSQL en fait un InitPlan évalué UNE fois.
        (coalesce(p.delivered_anchor, 0)
          * (select public.customer_reliability_decay_factor(now())))::numeric
          as delivered_weighted,
        (coalesce(p.refused_anchor, 0)
          * (select public.customer_reliability_decay_factor(now())))::numeric
          as refused_weighted,
        (coalesce(p.confirmed_anchor, 0)
          * (select public.customer_reliability_decay_factor(now())))::numeric
          as confirmed_weighted,
        (coalesce(p.attempts_anchor, 0)
          * (select public.customer_reliability_decay_factor(now())))::numeric
          as attempts_weighted,
        (coalesce(p.no_response_anchor, 0)
          * (select public.customer_reliability_decay_factor(now())))::numeric
          as no_response_weighted,
        p.computed_at
      from public.customer c
      left join public.customer_reliability_projection p
        on p.merchant_account_id = c.merchant_account_id
       and p.shop_id = c.shop_id
       and p.customer_id = c.id
    ) w
  ) b
) s;

revoke all on public.customer_reliability_scored from public, anon;
grant select on public.customer_reliability_scored to authenticated;

-- ── 9. Liste paginée ────────────────────────────────────────────────────────
-- Signature, type de retour, volatilité, search_path et sémantique identiques à
-- 0128. Deux branches EXPLICITES : un `case when p_sort_by_risk` dans l'ORDER BY
-- empêcherait le planificateur de choisir le parcours d'index du tri par nom, donc
-- la pagination-avant-enrichissement. D'où plpgsql plutôt que sql.
--
-- Toutes les colonnes sont qualifiées `v.` : `returns table (...)` déclare
-- customer_id / full_name / score / tier comme VARIABLES plpgsql, et une référence
-- non qualifiée à une colonne homonyme serait ambiguë (leçon 0086).
create or replace function public.list_store_customer_reliability(
  p_merchant_id uuid,
  p_shop_id uuid,
  p_search text default null,
  p_limit integer default 50,
  p_offset integer default 0,
  p_sort_by_risk boolean default false
)
returns table (
  customer_id uuid,
  full_name text,
  phone text,
  decided integer,
  delivered_count integer,
  refused_count integer,
  cancelled_count integer,
  order_count integer,
  delivered_lifetime numeric,
  delivered_weighted numeric,
  refused_weighted numeric,
  confirmed_weighted numeric,
  attempts_weighted numeric,
  no_response_weighted numeric,
  delivery_score numeric,
  confirm_score numeric,
  score integer,
  tier text,
  is_provisional boolean,
  flag_confirms_then_refuses boolean,
  flag_hard_to_reach boolean,
  flag_cancels_often boolean
)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if not public.is_shop_member_of(p_shop_id) then
    return;
  end if;

  if p_sort_by_risk then
    -- Classement global sur TOUS les clients filtrés, pas seulement la page :
    -- une passe ensembliste sur la projection, puis tri, puis pagination.
    return query
    select
      v.customer_id, v.full_name, v.phone, v.decided, v.delivered_count,
      v.refused_count, v.cancelled_count, v.order_count, v.delivered_lifetime,
      v.delivered_weighted, v.refused_weighted, v.confirmed_weighted,
      v.attempts_weighted, v.no_response_weighted, v.delivery_score,
      v.confirm_score, v.score, v.tier, v.is_provisional,
      v.flag_confirms_then_refuses, v.flag_hard_to_reach, v.flag_cancels_often
    from public.customer_reliability_scored v
    where v.merchant_account_id = p_merchant_id
      and v.shop_id = p_shop_id
      and (
        p_search is null
        or p_search = ''
        or lower(coalesce(v.full_name, '')) like '%' || lower(p_search) || '%'
        or coalesce(v.phone, '') like '%' || p_search || '%'
      )
    order by
      case v.tier when 'risk' then 0 when 'watch' then 1 when 'new' then 2
        when 'reliable' then 3 else 4 end,
      v.score asc nulls last,
      v.full_name asc nulls last,
      v.customer_id
    limit v_limit
    offset v_offset;
  else
    -- Tri par nom : filtre et pagination sur `customer` d'abord (index
    -- customer_tenant_shop_name_idx), enrichissement ensuite sur la seule page.
    return query
    select
      v.customer_id, v.full_name, v.phone, v.decided, v.delivered_count,
      v.refused_count, v.cancelled_count, v.order_count, v.delivered_lifetime,
      v.delivered_weighted, v.refused_weighted, v.confirmed_weighted,
      v.attempts_weighted, v.no_response_weighted, v.delivery_score,
      v.confirm_score, v.score, v.tier, v.is_provisional,
      v.flag_confirms_then_refuses, v.flag_hard_to_reach, v.flag_cancels_often
    from public.customer_reliability_scored v
    where v.merchant_account_id = p_merchant_id
      and v.shop_id = p_shop_id
      and (
        p_search is null
        or p_search = ''
        or lower(coalesce(v.full_name, '')) like '%' || lower(p_search) || '%'
        or coalesce(v.phone, '') like '%' || p_search || '%'
      )
    order by v.full_name asc nulls last, v.customer_id
    limit v_limit
    offset v_offset;
  end if;
end;
$$;

-- La signature est inchangée, donc `create or replace` conserve proacl ; les
-- grants sont reposés par prudence, conformément à la leçon 0067.
revoke all on function public.list_store_customer_reliability(uuid, uuid, text, integer, integer, boolean)
  from public, anon;
grant execute on function public.list_store_customer_reliability(uuid, uuid, text, integer, integer, boolean)
  to authenticated;

-- ── 10. Index de pagination par nom ─────────────────────────────────────────
-- `order by full_name asc nulls last, id` correspond exactement à l'ordre par
-- défaut d'un btree ascendant, donc ce seul index sert le tri ET le LIMIT.
create index if not exists customer_tenant_shop_name_idx
  on public.customer (merchant_account_id, shop_id, full_name, id);

analyze public.customer_reliability_projection;
