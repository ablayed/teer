-- 0164 — L11B-1 : politiques SELECT de orders et customer en ensembles d'appartenance
--
-- À appliquer APRÈS 0162 (écritures d'appartenance fermées) et 0163 (gardes de boutique des
-- écritures de commande) : ce lot ne corrige aucun droit, il suppose les deux précédents en place.
--
-- Mesuré en local (PostgreSQL 17.6, RLS active, rôle authenticated) : `orders_select` et
-- `customer_select` appellent `current_member_role(merchant_account_id)` et
-- `is_shop_member_of(shop_id)` pour CHAQUE ligne lue — 40 000 appels pour une boutique de
-- 20 000 commandes, quelle que soit la période. Les arguments étant des colonnes de la ligne,
-- PostgreSQL ne peut pas en faire un calcul unique. La politique pesait 86 à 95 % de la durée de
-- get_order_view_counts et de list_orders_keyset.
--
-- Changement : deux fonctions sans argument rendent, une fois par instruction, les comptes et
-- les boutiques dont l'appelant est membre ; les deux politiques comparent la ligne à ces
-- ensembles. Mêmes droits, par construction :
--   * compte ET boutique sont exigés, indépendamment ; un owner sans ligne shop_member ne voit
--     pas la boutique ; une ligne shop_member qui survit à la suppression du merchant_member
--     ne donne aucun accès ;
--   * l'identité vient de auth.uid() seul, aucun argument ;
--   * la fonction des boutiques exige, comme is_shop_member_of, que le compte de la ligne
--     shop_member soit celui de la boutique.
--
-- Ce qui ne change PAS : current_member_role, is_shop_member_of, current_shop_role et toutes les
-- autres politiques ; les politiques d'écriture de orders et customer ; les RPC métier, qui
-- restent SECURITY INVOKER ; les droits existants du schéma private.
--
-- Sécurité des deux fonctions :
--   * schéma private : non exposé par PostgREST ; authenticated y a déjà USAGE (0136) ;
--   * SECURITY DEFINER, propriétaire postgres : il contourne la RLS (rolbypassrls, confirmé en
--     production le 2026-10-09), donc aucune récursion par les politiques de merchant_member,
--     shop_member et shop, toutes en FORCE RLS ;
--   * search_path vide, tout nom qualifié ;
--   * une fonction créée dans private naît exécutable par PUBLIC (mesuré : aucun privilège par
--     défaut n'y est enregistré) — le REVOKE ci-dessous, qui nomme chaque rôle, est obligatoire.

create function private.current_user_merchant_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select mm.merchant_account_id
  from public.merchant_member mm
  where mm.user_id = auth.uid();
$$;

create function private.current_user_shop_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select sm.shop_id
  from public.shop_member sm
  join public.shop s on s.id = sm.shop_id
  where sm.user_id = auth.uid()
    and sm.merchant_account_id = s.merchant_account_id;
$$;

revoke all on function private.current_user_merchant_ids() from public, anon, authenticated, service_role;
revoke all on function private.current_user_shop_ids() from public, anon, authenticated, service_role;
grant execute on function private.current_user_merchant_ids() to authenticated;
grant execute on function private.current_user_shop_ids() to authenticated;

alter policy orders_select on public.orders
  using (
    merchant_account_id = any (array(select private.current_user_merchant_ids()))
    and shop_id = any (array(select private.current_user_shop_ids()))
  );

alter policy customer_select on public.customer
  using (
    merchant_account_id = any (array(select private.current_user_merchant_ids()))
    and shop_id = any (array(select private.current_user_shop_ids()))
  );
