-- Diagnostic READ-ONLY — bug CA/cards/stock datés au clic au lieu de scheduled_for.
-- Mesure l'ampleur historique d'un futur backfill (Option A : cash_collected_at :=
-- coalesce(scheduled_for, cash_collected_at) pour les commandes déjà livrées). Aucune
-- écriture (SELECT uniquement). À lancer manuellement par le porteur (éditeur SQL
-- Supabase / psql), jamais via `supabase migration up`.
--
-- Périmètre : commandes livrées/complétées (order_state='completed' AND
-- delivery_state='delivered') avec scheduled_for renseigné ET cash_collected_at
-- renseigné ET différent. Annulées/refusées/retournées exclues explicitement
-- (order_state IN ('cancelled','returned') OU delivery_state IN ('failed','returned'))
-- — hors scope du fix (décision porteur déjà actée).
--
-- Ce script NE modifie aucune donnée. Aucun backfill n'est exécuté ici.

-- 1. Comptage + montant CA concerné ---------------------------------------
with candidates as (
  select
    o.id,
    o.merchant_account_id,
    o.total_amount,
    o.scheduled_for,
    o.cash_collected_at,
    (o.scheduled_for < o.cash_collected_at) as scheduled_before_collected,
    extract(epoch from (o.cash_collected_at - o.scheduled_for)) / 86400.0 as gap_days
  from public.orders o
  where o.order_state = 'completed'
    and o.delivery_state = 'delivered'
    and o.scheduled_for is not null
    and o.cash_collected_at is not null
    and o.scheduled_for <> o.cash_collected_at
)
select
  count(*) as commandes_concernees,
  sum(total_amount)::bigint as ca_concerne_minor,
  count(*) filter (where scheduled_before_collected) as scheduled_avant_collecte,
  count(*) filter (where not scheduled_before_collected) as scheduled_apres_collecte,
  round(avg(abs(gap_days))::numeric, 1) as ecart_moyen_jours,
  round(min(gap_days)::numeric, 1) as ecart_min_jours,
  round(max(gap_days)::numeric, 1) as ecart_max_jours
from candidates;

-- 2. Distribution de l'écart en jours (buckets) ---------------------------
with candidates as (
  select
    o.total_amount,
    extract(epoch from (o.cash_collected_at - o.scheduled_for)) / 86400.0 as gap_days
  from public.orders o
  where o.order_state = 'completed'
    and o.delivery_state = 'delivered'
    and o.scheduled_for is not null
    and o.cash_collected_at is not null
    and o.scheduled_for <> o.cash_collected_at
)
select
  case
    when gap_days < 0 then 'scheduled_for > cash_collected_at (anomalie à investiguer)'
    when gap_days = 0 then '0 jour'
    when gap_days <= 1 then '0-1 jour'
    when gap_days <= 3 then '1-3 jours'
    when gap_days <= 7 then '3-7 jours'
    when gap_days <= 30 then '7-30 jours'
    else '30+ jours'
  end as bucket_ecart,
  count(*) as commandes,
  sum(total_amount)::bigint as ca_minor
from candidates
group by 1
order by min(gap_days);

-- 3. Cross-tabulation mois scheduled_for x mois cash_collected_at --------
-- (répartition combien de CA "migrerait" d'un mois de reporting à un autre)
with candidates as (
  select
    o.total_amount,
    date_trunc('month', o.scheduled_for) as mois_scheduled,
    date_trunc('month', o.cash_collected_at) as mois_collecte
  from public.orders o
  where o.order_state = 'completed'
    and o.delivery_state = 'delivered'
    and o.scheduled_for is not null
    and o.cash_collected_at is not null
    and o.scheduled_for <> o.cash_collected_at
)
select
  mois_scheduled,
  mois_collecte,
  count(*) as commandes,
  sum(total_amount)::bigint as ca_minor
from candidates
group by 1, 2
order by 1, 2;
