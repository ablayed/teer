-- ============================================================================
-- 0133 — Appartenance des livreurs aux boutiques
-- ============================================================================
-- DÉFAUT OBSERVÉ EN PRODUCTION (smoke authentifié, compte de test 2 boutiques)
--
--   `/livreurs` affiche les MÊMES livreurs dans les deux boutiques. Ce n'est pas
--   un oubli de filtre applicatif : `driver` n'a JAMAIS eu de `shop_id`. Elle ne
--   figure ni dans les 10 tables scopées par `0126` ni dans les 2 de `0127`, et sa
--   RLS (`driver_select`/`insert`/`update`/`delete`) est purement locataire.
--   Le schéma n'a donc aucune notion de livreur rattaché à une boutique — la page
--   lit `driver` filtrée sur `merchant_account_id` seul, alors qu'elle a pourtant
--   déjà résolu la boutique active. Une correction purement applicative est
--   impossible : il n'y a rien sur quoi filtrer.
--
-- POURQUOI UNE TABLE D'APPARTENANCE ET NON UNE COLONNE `driver.shop_id`
--
--   Mesuré en production avant toute conception, sur l'ensemble des tenants :
--   6 livreurs, 1 seul tenant multi-boutiques, et **1 livreur travaille
--   RÉELLEMENT pour les deux boutiques** — 8 commandes + 47 mouvements de stock
--   dans la boutique par défaut, 5 commandes + 16 mouvements dans la seconde.
--
--   Une colonne `shop_id` sur `driver` (une boutique par livreur) ne peut pas
--   représenter ce fait. Elle forcerait à choisir une boutique, rendant le livreur
--   invisible dans l'autre ALORS QUE 5 commandes et 16 mouvements continueraient
--   d'y pointer vers lui — et couperait en deux son cash consolidé et son stock en
--   main, qui se calculent sur l'ensemble de ses mouvements. Le cahier des charges
--   dit d'ailleurs « un livreur appartenant UNIQUEMENT à une autre boutique »,
--   formulation qui suppose bien qu'un livreur puisse en servir plusieurs.
--
--   D'où une table d'appartenance N-N. Un livreur reste une entité du LOCATAIRE
--   (son identité, son cash, son stock en main sont indivisibles) ; ce qui devient
--   scopé par boutique, c'est sa VISIBILITÉ et son ÉLIGIBILITÉ à l'affectation.
--
-- CE QUE CETTE MIGRATION NE FAIT PAS
--
--   Elle ne touche ni `driver`, ni sa RLS, ni `orders.assigned_driver_id`, ni
--   aucune donnée existante : purement additive. Les affectations historiques
--   inter-boutiques restent valides et lisibles — les invalider rétroactivement
--   supprimerait de l'historique réel pour satisfaire une règle introduite après
--   coup.
-- ============================================================================

-- Cible de FK composite. `id` étant déjà la PK, ce couple est trivialement
-- unique ; la contrainte n'existe que pour permettre à `driver_shop` d'exiger que
-- le livreur et la boutique appartiennent au MÊME locataire.
alter table public.driver
  drop constraint if exists driver_tenant_id_key;
alter table public.driver
  add constraint driver_tenant_id_key unique (merchant_account_id, id);

create table if not exists public.driver_shop (
  merchant_account_id uuid not null,
  shop_id uuid not null,
  driver_id uuid not null,
  created_at timestamptz not null default now(),
  constraint driver_shop_pkey primary key (merchant_account_id, shop_id, driver_id),
  constraint driver_shop_shop_tenant_fk
    foreign key (merchant_account_id, shop_id)
    references public.shop (merchant_account_id, id)
    on delete cascade,
  constraint driver_shop_driver_tenant_fk
    foreign key (merchant_account_id, driver_id)
    references public.driver (merchant_account_id, id)
    on delete cascade
);

-- Sens de lecture dominant : « quels livreurs pour cette boutique ». La PK sert
-- déjà ce préfixe ; cet index sert le sens inverse (« quelles boutiques pour ce
-- livreur »), utilisé par la garde d'affectation.
create index if not exists driver_shop_driver_idx
  on public.driver_shop (merchant_account_id, driver_id, shop_id);

alter table public.driver_shop enable row level security;
alter table public.driver_shop force row level security;

-- Lecture : tout membre de la boutique (agent inclus — l'affectation est un geste
-- d'agent). Écriture : owner/manager uniquement, alignée sur `driver_insert`.
drop policy if exists driver_shop_select on public.driver_shop;
create policy driver_shop_select on public.driver_shop
  for select to authenticated
  using (
    public.current_member_role(merchant_account_id) is not null
    and public.is_shop_member_of(shop_id)
  );

drop policy if exists driver_shop_insert on public.driver_shop;
create policy driver_shop_insert on public.driver_shop
  for insert to authenticated
  with check (
    public.current_member_role(merchant_account_id) in ('owner', 'manager')
    and public.is_shop_member_of(shop_id)
  );

drop policy if exists driver_shop_delete on public.driver_shop;
create policy driver_shop_delete on public.driver_shop
  for delete to authenticated
  using (
    public.current_member_role(merchant_account_id) in ('owner', 'manager')
    and public.is_shop_member_of(shop_id)
  );

-- Pas de policy UPDATE : une appartenance se crée ou se supprime, elle ne se
-- déplace pas. La modifier reviendrait à transférer un livreur d'une boutique à
-- une autre sans trace, exactement ce que `prevent_store_context_change` interdit
-- ailleurs.

revoke all on table public.driver_shop from public, anon, authenticated;
grant select, insert, delete on table public.driver_shop to authenticated;

-- ── Backfill ────────────────────────────────────────────────────────────────
-- Dérivé de l'ACTIVITÉ RÉELLE observée, jamais d'un repli sur la boutique par
-- défaut : un livreur est rattaché à toute boutique où il a effectivement une
-- commande affectée ou un mouvement de stock. C'est ce qui préserve le livreur
-- qui sert les deux boutiques.
insert into public.driver_shop (merchant_account_id, shop_id, driver_id)
select distinct o.merchant_account_id, o.shop_id, o.assigned_driver_id
from public.orders o
where o.assigned_driver_id is not null
on conflict do nothing;

insert into public.driver_shop (merchant_account_id, shop_id, driver_id)
select distinct m.merchant_account_id, m.shop_id, m.driver_id
from public.stock_movement m
where m.driver_id is not null
on conflict do nothing;

-- Livreur sans aucune activité (jamais affecté, aucun mouvement) : rattaché à la
-- boutique par défaut, faute de signal. Sans cette clause il n'apparaîtrait NULLE
-- PART et deviendrait inatteignable — une régression pire que le défaut corrigé.
-- Pour un locataire mono-boutique, ce repli et l'activité désignent la même et
-- unique boutique : le comportement y est donc rigoureusement inchangé.
insert into public.driver_shop (merchant_account_id, shop_id, driver_id)
select d.merchant_account_id, s.id, d.id
from public.driver d
join public.shop s
  on s.merchant_account_id = d.merchant_account_id
 and s.is_default
where not exists (
  select 1 from public.driver_shop ds
  where ds.merchant_account_id = d.merchant_account_id and ds.driver_id = d.id
)
on conflict do nothing;

-- Aucun livreur ne doit sortir de cette migration sans boutique : échouer
-- bruyamment plutôt que rendre un livreur invisible partout.
do $$
declare
  v_orphans bigint;
begin
  select count(*) into v_orphans
  from public.driver d
  where not exists (
    select 1 from public.driver_shop ds
    where ds.merchant_account_id = d.merchant_account_id and ds.driver_id = d.id
  );

  if v_orphans > 0 then
    raise exception 'driver_shop_backfill_incomplete drivers=%', v_orphans;
  end if;
end;
$$;

-- ── Garde d'éligibilité ─────────────────────────────────────────────────────
-- Utilisée par la couche applicative pour refuser l'affectation d'un livreur qui
-- ne sert pas la boutique de la commande. `security definer` + garde de rôle
-- NULL-safe : un non-membre ne doit pas pouvoir sonder l'appartenance des
-- livreurs d'un autre locataire.
create or replace function public.is_driver_in_shop(
  p_merchant_account_id uuid,
  p_driver_id uuid,
  p_shop_id uuid
)
returns boolean
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_role text;
begin
  v_role := public.current_member_role(p_merchant_account_id);
  if v_role is null then
    return false;
  end if;

  return exists (
    select 1
    from public.driver_shop ds
    where ds.merchant_account_id = p_merchant_account_id
      and ds.driver_id = p_driver_id
      and ds.shop_id = p_shop_id
  );
end;
$$;

revoke all on function public.is_driver_in_shop(uuid, uuid, uuid) from public, anon;
grant execute on function public.is_driver_in_shop(uuid, uuid, uuid) to authenticated, service_role;

analyze public.driver_shop;
