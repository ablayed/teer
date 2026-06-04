-- ============================================================
-- Nettoyage one-shot : doublons de livreurs créés par le bug de
-- reset du formulaire (phase4). À exécuter dans Supabase Studio
-- (SQL editor) sur le projet, OU via `supabase db execute`.
--
-- Règle (identique à removeDriverAction) :
--   - on conserve le plus ANCIEN livreur par (merchant, nom, téléphone) ;
--   - on ne SUPPRIME que les doublons TOTALEMENT VIERGES
--     (aucune commande assignée, aucun cash, aucun mouvement de stock) ;
--   - un doublon qui aurait un historique n'est PAS touché ici
--     (à désactiver manuellement depuis l'UI si besoin).
--
-- Lancer d'abord le SELECT pour vérifier, puis le DELETE.
-- ============================================================

with ranked as (
  select
    id,
    row_number() over (
      partition by merchant_account_id, full_name, phone
      order by created_at, id
    ) as rn
  from public.driver
),
deletable as (
  select d.id
  from public.driver d
  join ranked r on r.id = d.id and r.rn > 1
  where not exists (select 1 from public.orders o where o.assigned_driver_id = d.id)
    and not exists (select 1 from public.cash_settlement cs where cs.driver_id = d.id)
    and not exists (select 1 from public.settlement_shortfall sf where sf.driver_id = d.id)
    and not exists (select 1 from public.stock_movement sm where sm.driver_id = d.id)
)
-- Vérification (commenter le DELETE, lancer ceci d'abord) :
-- select * from public.driver where id in (select id from deletable);
delete from public.driver where id in (select id from deletable);
