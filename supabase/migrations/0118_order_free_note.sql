-- ============================================================
-- 0118 — Note libre sur la commande
--
-- Nouvelle colonne `orders.note` : une note d'équipe libre, éditable à tout
-- moment du cycle de vie, INDÉPENDANTE de toute transition d'état.
--
-- À NE PAS CONFONDRE avec les deux `note` déjà présentes dans le produit :
--   1. `order_state_transition.note` — note liée à UNE ACTION précise et
--      horodatée (annulation « autres », réassignation livreur). Conservée
--      telle quelle : ni migrée, ni fusionnée, ni affichée par ce lot.
--   2. `orders.shopify_order_attributes->>'note'` — note écrite par le CLIENT
--      sur Shopify, en lecture seule, affichée sous « Détails supplémentaires ».
--
-- ------------------------------------------------------------
-- POURQUOI UNE RPC ET PAS UN SIMPLE `update` PostgREST
-- ------------------------------------------------------------
-- La policy `orders_update` (0020, toujours vivante) borne l'agent à
--   cod_status in ('TENTEE', 'CONFIRMEE', 'PROGRAMMEE', 'EN_LIVRAISON')
-- via son WITH CHECK. Un `update` direct sur `note` échouerait donc pour un
-- agent sur une commande `A_APPELER` (avant tout appel) ou `LIVREE` (après
-- livraison) — exactement les deux cas que la décision produit exige de
-- couvrir pour les trois rôles.
--
-- Élargir `orders_update` donnerait à l'agent le droit d'écrire N'IMPORTE
-- QUELLE colonne dans ces états (montants, dimensions, livreur) : ce serait un
-- changement de RBAC bien au-delà du périmètre de ce lot. RLS ne sait pas
-- restreindre un UPDATE à une seule colonne.
--
-- D'où `set_order_note` : `security definer`, portée à la seule colonne `note`,
-- avec sa propre garde de rôle NULL-safe. `orders_update` reste INCHANGÉE.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- (1) La colonne
-- ────────────────────────────────────────────────────────────
alter table public.orders
  add column if not exists note text;

comment on column public.orders.note is
  'Note libre d''équipe sur la commande, éditable à tout moment et '
  'indépendante de toute transition d''état. Distincte de '
  'order_state_transition.note (liée à une action précise) et de '
  'shopify_order_attributes->>''note'' (écrite par le client sur Shopify).';

-- Défense en profondeur : la RPC valide déjà la longueur, mais la contrainte
-- protège aussi tout futur chemin d'écriture (service-role, script, backfill).
-- Aucune ligne existante n'a de valeur : la contrainte peut être validée
-- immédiatement, sans `not valid` / `validate constraint`.
alter table public.orders
  add constraint orders_note_max_length
  check (note is null or char_length(note) <= 500);

-- ────────────────────────────────────────────────────────────
-- (2) set_order_note — écriture bornée à la seule colonne `note`
-- ────────────────────────────────────────────────────────────
create or replace function public.set_order_note(
  p_order_id uuid,
  p_note     text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_account_id uuid;
  v_role                text;
  v_note                text;
begin
  select merchant_account_id
    into v_merchant_account_id
    from public.orders
   where id = p_order_id;

  if v_merchant_account_id is null then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  -- Garde NULL-safe obligatoire : `current_member_role` renvoie NULL pour un
  -- non-membre, et `NULL not in (...)` ne vaut PAS TRUE — sans le test `is null`
  -- explicite la garde serait silencieusement sautée (fuite cross-tenant).
  v_role := public.current_member_role(v_merchant_account_id);

  if v_role is null or v_role not in ('owner', 'manager', 'agent') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_note := nullif(btrim(coalesce(p_note, '')), '');

  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'note_too_long' using errcode = '22001';
  end if;

  -- `updated_at` est bumpé par le trigger `orders_set_updated_at`.
  -- `cod_status` est recalculé par `derive_legacy_cod_status` à partir des 4
  -- dimensions, qu'on ne touche pas : sa valeur reste identique.
  update public.orders
     set note = v_note
   where id = p_order_id;

  return v_note;
end;
$$;

comment on function public.set_order_note(uuid, text) is
  'Écrit la note libre d''une commande. Portée volontairement limitée à la '
  'colonne `note` : permet à l''agent d''écrire quel que soit le cod_status '
  'sans élargir la policy orders_update.';

-- Fonction NEUVE : aucun grant hérité d'une signature précédente. On pose
-- quand même le revoke explicite (leçon 0067 : un create rouvre EXECUTE à
-- PUBLIC par défaut).
revoke all on function public.set_order_note(uuid, text) from public, anon;
grant execute on function public.set_order_note(uuid, text) to authenticated, service_role;
