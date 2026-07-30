-- 0117 : finance_kpis expose delivered_orders_count — fermeture du gap « Invalider »
-- sur /finances.
--
-- DEFAUT CORRIGE
-- /finances comptait ses livraisons avec une requete AUTONOME sur order_state_transition
-- (app/(app)/finances/page.tsx), sans aucune jointure vers `orders` :
--
--     .from('order_state_transition')
--     .select('id', { count: 'exact', head: true })
--     .eq('to_status', 'LIVREE')
--     .gte('created_at', from).lte('created_at', to)
--
-- Elle comptait donc « il y a eu un clic Livrer un jour » comme un fait definitif. Deux
-- consequences, la seconde aggravee par 0116 :
--   1. une commande INVALIDEE restait comptee comme livree (sa transition LIVREE subsiste,
--      volontairement — l'historique n'est jamais reecrit) ;
--   2. une commande livree, invalidee, puis RE-livree comptait DEUX fois, puisque la
--      requete comptait des LIGNES DE TRANSITION et non des commandes distinctes.
--
-- IMPACT FINANCIER REEL, pas cosmetique : ce compteur alimente
-- `deliveredOrdersCount` -> `lib/finance/fees.ts:106`
-- (`deliveryCostsMinor = deliveredOrdersCount * default_delivery_cost_minor`), donc une
-- ligne de COUT du P&L. Un faux positif gonflait les couts de livraison et minorait la marge.
--
-- CORRECTIF
-- Le comptage n'est pas « reparé » cote TS : il est deplace dans `finance_kpis`, qui calcule
-- DEJA l'ensemble exact voulu dans sa CTE `delivered_orders` :
--   * bornee a `o.cod_status = 'LIVREE'` — l'etat COURANT de la commande (une commande
--     invalidee est A_APPELER, elle en sort d'elle-meme, sans predicat dedie sur 0116) ;
--   * `group by o.id` — donc un `count(*)` y compte des commandes DISTINCTES, ce qui neutralise
--     structurellement le double comptage du cas re-livraison ;
--   * meme fenetre que `ca_livre` : `d.delivered_at >= p_from and d.delivered_at < p_to`, ou
--     `delivered_at = coalesce(max(ost.created_at), o.updated_at)`.
-- Le nombre de livraisons et le CA livre deviennent donc definitionnellement coherents : meme
-- ensemble de commandes, meme fenetre, meme repli `updated_at` quand aucune transition
-- n'existe. C'est plus aligne qu'avant, pas moins.
--
-- CE QUI N'EST VOLONTAIREMENT PAS TOUCHE
-- Les 3 autres fonctions finance qui lisent order_state_transition (`cash_aging`,
-- `record_cash_settlement`, `write_off_shortfall`) ont ete auditees ligne a ligne : toutes
-- filtrent deja sur `o.cod_status = 'LIVREE'` et n'utilisent la transition QUE pour derive
-- l'horodatage `delivered_at`, jamais pour decider l'appartenance a l'ensemble. Aucune n'a
-- le defaut, aucune n'est modifiee.
--
-- PORTEE : la colonne de sortie ajoutee et son `count(*) filter`. Tout le corps de 0065 est
-- repris VERBATIM (fichier genere par patch programmatique du corps de 0065, une seule
-- insertion). Aucune colonne de table, aucune donnee, aucune ligne d'historique touchee.
--
-- Le TYPE DE RETOUR change (6 colonnes au lieu de 5) : PostgreSQL refuse un
-- `create or replace` dans ce cas, il faut DROP puis CREATE. Or un DROP+CREATE cree une
-- fonction NEUVE, qui repart avec `EXECUTE` ouvert a PUBLIC — les `revoke`/`grant` de 0065
-- portent sur l'ancienne fonction et ne s'y appliquent pas (lecon de 0067). Les privileges
-- sont donc reposes explicitement en fin de fichier.

drop function if exists public.finance_kpis(uuid, timestamptz, timestamptz, uuid);

create function public.finance_kpis(
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
      coalesce(max(ost.created_at), o.updated_at) as delivered_at
    from public.orders o
    left join public.order_state_transition ost
      on ost.order_id = o.id
     and ost.to_status = 'LIVREE'
    where o.merchant_account_id = p_merchant
      and o.cod_status = 'LIVREE'
      and (p_shop_id is null or o.shop_id = p_shop_id)
      and (select role from role_guard) in ('owner','manager')
    group by o.id, o.total_amount, o.updated_at
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
    -- 0117 : nombre de commandes livrees, MEME ensemble et MEME fenetre que ca_livre
    -- ci-dessus. delivered_orders est deja borne a o.cod_status = 'LIVREE' (etat COURANT)
    -- et groupe par o.id, donc ce count() est un compte de COMMANDES DISTINCTES.
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

-- Privileges reposes sur la NOUVELLE fonction (cf. lecon de 0067 en tete de fichier).
revoke all on function public.finance_kpis(uuid, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.finance_kpis(uuid, timestamptz, timestamptz, uuid)
  to authenticated;
