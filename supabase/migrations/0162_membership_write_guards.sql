-- 0162 — Appartenance : fermeture des écritures directes et garde du dernier owner.
--
-- Défauts démontrés en local le 2026-10-09 par appels PostgREST directs, sous session :
--   * mm_delete (0001:77, jamais redéfinie) : `is_member_of(merchant_account_id)`. Tout membre,
--     agent compris, supprimait n'importe quelle ligne du compte, owners compris, jusqu'au
--     dernier.
--   * shop_member_insert / shop_member_update (0126:158-164) : seul le rôle de compte
--     owner/manager était exigé ; ni le rôle attribué, ni les colonnes, ni la boutique n'étaient
--     bornés. Un manager se donnait le rôle owner d'une boutique, entrait dans une boutique dont
--     il était exclu, puis lisait les arrivages, supprimait des commandes et supprimait la
--     boutique.
--
-- Appelants (règle 12) : aucun code applicatif n'écrit ces deux tables avec un client de
-- session. Retrait et changement de rôle passent par le client service-role
-- (lib/actions/team.ts), qui contourne la RLS ; les lignes shop_member sont écrites par des
-- triggers SECURITY DEFINER (0126:179-215). Supprimer ces trois politiques ne retire donc aucun
-- chemin applicatif : RLS forcée et refus par défaut ferment l'appel direct.
--
-- Ce que la migration ne fait pas (lot suivant) : nettoyer les shop_member restants après un
-- retrait, borner la réouverture des boutiques à la réinsertion, auditer les suppressions.

-- ── 1. merchant_member : plus aucune suppression par un client de session ───────────────────
drop policy if exists mm_delete on public.merchant_member;

-- ── 2. shop_member : plus aucune écriture directe par un client de session ──────────────────
-- La lecture (shop_member_select) et la suppression par l'owner du compte (shop_member_delete)
-- ne changent pas.
drop policy if exists shop_member_insert on public.shop_member;
drop policy if exists shop_member_update on public.shop_member;

-- ── 3. Dernier owner : garde en base, pour TOUS les rôles ───────────────────────────────────
-- La garde applicative (compter les owners, puis écrire) n'est pas atomique : deux retraits
-- concurrents lisent chacun deux owners. Ici, la ligne du compte est verrouillée avant le
-- décompte : le second retrait attend le premier, puis recompte.
--
-- Le verrou est FOR NO KEY UPDATE : il sérialise deux retraits entre eux sans bloquer les
-- insertions qui référencent le compte (elles prennent FOR KEY SHARE).
--
-- La garde s'applique à tout appelant, rôle de service et SQL direct compris. Deux cascades
-- légitimes sont reconnues à leur cause, jamais à la profondeur de trigger :
--   * le COMPTE est supprimé : sa ligne n'existe plus quand la cascade atteint ses membres ;
--   * l'UTILISATEUR est supprimé dans auth.users : sa ligne n'existe plus quand la cascade
--     atteint son appartenance. Un compte peut alors rester sans owner ; c'est le sort voulu
--     d'un compte dont le dernier propriétaire est supprimé, pas un contournement, puisque
--     aucun client de session ne supprime de ligne dans auth.users.
create function public.prevent_last_owner_removal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role <> 'owner' then
    return coalesce(new, old);
  end if;

  -- La ligne reste owner du même compte : rien à garder.
  if tg_op = 'UPDATE'
     and new.role = 'owner'
     and new.merchant_account_id = old.merchant_account_id
  then
    return new;
  end if;

  perform 1
     from public.merchant_account ma
    where ma.id = old.merchant_account_id
      for no key update;

  -- Cascade « suppression du compte ».
  if not found then
    return coalesce(new, old);
  end if;

  -- Cascade « suppression de l'utilisateur ».
  if tg_op = 'DELETE'
     and not exists (select 1 from auth.users u where u.id = old.user_id)
  then
    return old;
  end if;

  if not exists (
    select 1
      from public.merchant_member mm
     where mm.merchant_account_id = old.merchant_account_id
       and mm.role = 'owner'
       and mm.id <> old.id
  ) then
    raise exception 'last_owner'
      using errcode = '23514';
  end if;

  return coalesce(new, old);
end;
$$;

revoke all on function public.prevent_last_owner_removal()
  from public, anon, authenticated, service_role;

create trigger merchant_member_last_owner_guard
  before delete or update of role, merchant_account_id on public.merchant_member
  for each row execute function public.prevent_last_owner_removal();
