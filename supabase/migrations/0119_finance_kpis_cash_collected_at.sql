-- 0119 : finance_kpis se rebase sur orders.cash_collected_at pour dater les livraisons
-- (ca_livre + delivered_orders_count), au lieu du timestamp technique de transition.
--
-- DEFAUT CORRIGE
-- Depuis la migration 0114, cash_collected_at est EDITABLE : au clic « Marquer livrée »,
-- un manager/agent peut saisir p_delivered_at avec une date de livraison réelle antérieure
-- au clic (transitions.ts -> transition_order). Mais finance_kpis (0065 -> 0117) continuait
-- à dater ses commandes livrées avec :
--
--     delivered_at = coalesce(max(order_state_transition.created_at WHERE to_status='LIVREE'),
--                             orders.updated_at)
--
-- ...c'est-à-dire l'instant du CLIC serveur, jamais la date de livraison saisie. Une commande
-- livrée réellement le 30/07 mais cliquée le 01/08 (avec cash_collected_at édité à 30/07)
-- tombait donc en AOUT dans finance_kpis.ca_livre/delivered_orders_count, alors que le P&L
-- (lib/finance/report-data.ts:57-58, déjà sur cash_collected_at), les coûts livreur
-- (lib/finance/driver-cost.ts:154-155), les versements (finances/page.tsx:267-268) et le
-- Tableau (ca_collecte_7j, CA encaissé, Livraisons par produit — tous sur cash_collected_at)
-- la comptaient en JUILLET. Même écran /finances, mêmes bornes from/to, deux mois différents
-- pour la même commande. Confirmé par audit read-only du compte pilote GETGET SN
-- (merchant_account.id 6585e114-7aac-45ec-b311-7bd4e0273480) : mécanisme structurel latent,
-- aucun écart de mois observé sur l'échantillon actuel faute de commande concernée à date.
--
-- CORRECTIF
-- delivered_at = coalesce(cash_collected_at, max(order_state_transition.created_at WHERE
-- to_status='LIVREE'), orders.updated_at). Le fallback (ancienne logique, inchangée) ne
-- s'applique QUE si cash_collected_at est NULL — cas des commandes livrées avant l'existence
-- du champ (avant 0096) ou jamais renseigné pour une autre raison. Aucune commande avec
-- cash_collected_at non NULL ne peut donc changer de comportement par rapport à un scénario
-- où le fallback n'existerait pas ; les commandes SANS cash_collected_at gardent exactement
-- le mois qu'elles affichaient avant ce lot — aucun déplacement rétroactif pour elles.
--
-- SIGNATURE ET TYPE DE RETOUR INCHANGES (toujours 6 colonnes : ca_livre,
-- delivered_orders_count, cash_chez_livreurs, encaisse, a_encaisser, taux_refus) :
-- `create or replace function` est donc légal et NE réinitialise PAS les privilèges
-- (contrairement à un DROP+CREATE — leçon de 0067/0117). Aucun revoke/grant à reposer ici.
--
-- PORTEE : uniquement la définition de `delivered_at` dans la CTE `delivered_orders`, et
-- l'ajout de `o.cash_collected_at` au `group by` (requis car il devient une colonne
-- sélectionnée non agrégée). Tout le reste du corps de 0117 est repris à l'identique
-- (collected_by_driver, remitted_by_driver, outstanding_by_driver, refusal_counts, la
-- projection finale) — diff programmatique d'une seule ligne dans le corps de la CTE.

create or replace function public.finance_kpis(
  p_merchant uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_shop_id uuid default null
)
returns table (
  ca_livre bigint,
  delivered_orders_count bigint,
  cash_chez_livreurs bigint,
  encaisse bigint,
  a_encaisser bigint,
  taux_refus numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with role_guard as (
    select public.current_member_role(p_merchant) as role
  ),
  delivered_orders as (
    select
      o.id,
      o.total_amount,
      -- 0119 : cash_collected_at (date de livraison réelle, éditable depuis 0114) prime sur
      -- l'ancien timestamp de transition ; fallback uniquement si cash_collected_at IS NULL
      -- (commandes livrées avant l'existence du champ — ne bougent pas de mois par ce lot).
      coalesce(o.cash_collected_at, max(ost.created_at), o.updated_at) as delivered_at
    from public.orders o
    left join public.order_state_transition ost
      on ost.order_id = o.id
     and ost.to_status = 'LIVREE'
    where o.merchant_account_id = p_merchant
      and o.cod_status = 'LIVREE'
      and (p_shop_id is null or o.shop_id = p_shop_id)
      and (select role from role_guard) in ('owner','manager')
    group by o.id, o.total_amount, o.updated_at, o.cash_collected_at
  ),
  -- Ensemble « collecté » = cash réellement passé entre les mains du livreur, exactement
  -- comme deriveDriverCashConsolidation : cash_state ∈ {collected,remitted,discrepancy}.
  -- collectable = coalesce(stored, canal mobile ? 0 : round(total)) — réplique cashCollectableMinor.
  -- frais = delivery_fee des commandes collectées. Cross-boutiques (pas de p_shop_id).
  collected_by_driver as (
    select
      o.assigned_driver_id as driver_id,
      sum(
        coalesce(
          o.cash_collectable_minor,
          case
            when coalesce(o.payment_channel_at_delivery, 'INCONNU')
                 in ('WAVE','ORANGE_MONEY','FREE_MONEY') then 0
            else round(o.total_amount)::bigint
          end
        )
      ) as collected_minor,
      sum(coalesce(o.delivery_fee_minor, 0)) as fees_minor
    from public.orders o
    where o.merchant_account_id = p_merchant
      and o.assigned_driver_id is not null
      and o.cash_state in ('collected','remitted','discrepancy')
      and (select role from role_guard) in ('owner','manager')
    group by o.assigned_driver_id
  ),
  -- « remis » = Σ allocations sur TOUTES les commandes du livreur (jointure séparée pour
  -- éviter que le fan-out des allocations ne multiplie collected_minor). Idem réf. TS.
  remitted_by_driver as (
    select
      o.assigned_driver_id as driver_id,
      coalesce(sum(sa.allocated_minor), 0) as remitted_minor
    from public.orders o
    join public.settlement_allocation sa
      on sa.order_id = o.id
     and sa.merchant_account_id = o.merchant_account_id
    where o.merchant_account_id = p_merchant
      and o.assigned_driver_id is not null
      and (select role from role_guard) in ('owner','manager')
    group by o.assigned_driver_id
  ),
  -- cashOnHand par livreur = greatest(collecté − frais − remis, 0), clamp AGRÉGÉ.
  outstanding_by_driver as (
    select
      c.driver_id,
      greatest(c.collected_minor - c.fees_minor - coalesce(r.remitted_minor, 0), 0)
        as outstanding_minor
    from collected_by_driver c
    left join remitted_by_driver r on r.driver_id = c.driver_id
  ),
  refusal_counts as (
    select
      count(*) filter (where cod_status in ('REFUSEE','ANNULEE'))::numeric as refused,
      count(*) filter (where cod_status in ('LIVREE','REFUSEE','ANNULEE'))::numeric as decided
    from public.orders
    where merchant_account_id = p_merchant
      and created_at >= p_from
      and created_at < p_to
      and (p_shop_id is null or shop_id = p_shop_id)
      and (select role from role_guard) in ('owner','manager')
  )
  select
    coalesce(sum(round(d.total_amount)::bigint) filter (
      where d.delivered_at >= p_from and d.delivered_at < p_to
    ), 0)::bigint as ca_livre,
    -- nombre de commandes livrees, MEME ensemble et MEME fenetre que ca_livre ci-dessus.
    -- delivered_orders est deja borne a o.cod_status = 'LIVREE' (etat COURANT, 0117) et
    -- groupe par o.id, donc ce count() est un compte de COMMANDES DISTINCTES.
    count(*) filter (
      where d.delivered_at >= p_from and d.delivered_at < p_to
    )::bigint as delivered_orders_count,
    coalesce((select sum(outstanding_minor) from outstanding_by_driver), 0)::bigint
      as cash_chez_livreurs,
    coalesce((
      select sum(amount_received_minor)
      from public.cash_settlement
      where merchant_account_id = p_merchant
        and settled_at >= p_from
        and settled_at < p_to
        and (select role from role_guard) in ('owner','manager')
    ), 0)::bigint as encaisse,
    coalesce((select sum(outstanding_minor) from outstanding_by_driver), 0)::bigint
      as a_encaisser,
    coalesce((
      select 100.0 * refused / nullif(decided, 0)
      from refusal_counts
    ), 0)::numeric as taux_refus
  from delivered_orders d
  having (select role from role_guard) in ('owner','manager');
$$;

-- Signature et grants INCHANGES (CREATE OR REPLACE, pas de DROP) : rien à reposer ici.
