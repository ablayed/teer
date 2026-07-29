-- 0114 : Deux dates éditables — date de confirmation client (nouvelle colonne
-- `orders.call_confirmed_at`) + date de livraison corrigeable (`cash_collected_at`).
--
-- CONTEXTE
-- Le bureau enregistre souvent une commande APRÈS le fait réel : un client confirme
-- mardi 20h, l'agent traite le dossier mercredi matin ; un livreur livre le 24, le
-- bureau clique « Marquer livrée » le 26. Jusqu'ici les deux moments étaient figés à
-- l'instant du clic (`now()`), sans aucun moyen de les corriger.
--
-- 1) `orders.call_confirmed_at timestamptz null` — NOUVELLE colonne. Aucun équivalent
--    n'existait : l'audit du modèle confirme qu'`orders` n'a ni `validated_at`, ni
--    `confirmed_at`, ni `delivered_at` (`delivered_at` n'existe que comme ALIAS dérivé
--    `coalesce(max(ost.created_at), o.updated_at)` dans 0017/0018/0064/0083, jamais
--    comme colonne). Le moment de la confirmation n'était donc capturé que par
--    l'historique append-only `order_state_transition`, c'est-à-dire l'instant du clic.
--    Nullable, sans DEFAULT, AUCUN backfill : les commandes déjà confirmées avant ce lot
--    gardent `null` — décision produit explicite (pas de rétroactivité).
--
-- 2) `transition_order` gagne DEUX paramètres optionnels indépendants :
--      p_call_confirmed_at — date/heure réelle de la confirmation client
--      p_delivered_at      — date/heure réelle de la livraison
--    Chacun n'est saisi qu'au moment de SA propre transition (confirmation vs livraison) ;
--    aucun des deux ne modifie jamais l'autre colonne.
--
-- 3) `cash_collected_at` : la branche posée en 0096 puis reprise en 0106/0109
--    (`coalesce(v_order.scheduled_for, now())`) devient
--    `coalesce(p_delivered_at, v_order.scheduled_for, now())`. L'ordre est délibéré :
--    une saisie explicite de l'utilisateur au moment de livrer gagne sur la date
--    programmée, qui gagne toujours sur `now()` (mécanisme PR #81 intact). La garde
--    d'idempotence `cash_collected_at is null` est CONSERVÉE telle quelle.
--
--    ⚠️ Piège vérifié : la branche lit `v_order.scheduled_for` (la ligne chargée en
--    `select … for update` AVANT l'UPDATE), donc un `p_scheduled_for` passé dans le MÊME
--    appel n'aurait aucun effet ici. C'est précisément pourquoi un paramètre dédié
--    `p_delivered_at` est nécessaire, et pourquoi réutiliser `p_scheduled_for` n'aurait
--    pas fonctionné.
--
-- 4) Bornes de cohérence, validées CÔTÉ SERVEUR dans la fonction (donc incontournables,
--    y compris par un appel RPC direct), avec un errcode distinct par violation pour que
--    la couche TS rende un message clair :
--      invalid_date_future    — jamais dans le futur (tolérance d'horloge : 5 minutes,
--                               l'horloge du navigateur pouvant devancer celle du serveur)
--      invalid_date_before_creation — jamais avant la création de la commande. ⚠️ Borne
--                               prise sur `least(created_at, created_at_shopify)` et NON
--                               sur `created_at` seul : pour une commande Shopify importée
--                               après coup, `created_at` est la date d'IMPORT, postérieure
--                               à la commande réelle — borner dessus rejetterait des
--                               corrections parfaitement légitimes. Écart assumé et signalé
--                               au porteur ; strictement plus permissif, jamais moins.
--      invalid_confirmation_after_delivery — confirmation ≤ livraison, dans les deux sens
--                               de saisie (corriger la confirmation d'une commande déjà
--                               livrée, ou corriger la livraison d'une commande déjà
--                               confirmée)
--
-- 5) `call_confirmed_at` est posée quand `call_state` DEVIENT 'validated' et qu'elle est
--    encore nulle — condition dimensionnelle, exactement comme `cash_collected_at`. Elle
--    couvre donc `confirmer` ET `programmer` (qui pose `call_state='validated'` en même
--    temps que `scheduled`), sans les énumérer : `programmer` est le geste de confirmation
--    réellement visible dans le produit (`visibleAllowedActions` masque `confirmer` dès que
--    `programmer` est proposée, ce qui est toujours le cas aux mêmes états).
--
-- PORTÉE : signature + bloc de validation + 2 colonnes de l'UPDATE. Tout le reste de
-- transition_order (dispatch/sold/courier_return/reserve/release, advance_commit,
-- order_assignment_commit/release avec la résolution bundle de 0109, reprise de cash sur
-- retour) est repris VERBATIM de 0109, à vérifier par diff avant merge.
-- `reassign_order_driver` n'est pas touchée par ce lot (aucune de ces deux dates n'entre
-- dans une réassignation).

alter table public.orders
  add column if not exists call_confirmed_at timestamptz;

comment on column public.orders.call_confirmed_at is
  'Date/heure réelle de la confirmation client. Posée par transition_order quand call_state devient validated, en coalesce(saisie utilisateur, now()). Null pour toute commande confirmée avant la migration 0114 : aucun backfill.';

-- La signature change (2 paramètres de plus) : un `create or replace` créerait une
-- SURCHARGE au lieu de remplacer, et les deux versions coexisteraient. On DROP donc
-- explicitement l'ancienne signature à 17 arguments (même geste qu'en 0099 pour
-- get_driver_cash_consolidation) avant de recréer.
drop function if exists public.transition_order(
  uuid, uuid, text, text, text, text, text, text, integer, timestamptz, timestamptz,
  text, uuid, text[], boolean, boolean, boolean
);

create or replace function public.transition_order(
  p_order_id              uuid,
  p_actor                 uuid,
  p_note                  text         default null,
  p_payment_channel       text         default 'ESPECES',
  p_order_state           text         default null,
  p_call_state            text         default null,
  p_delivery_state        text         default null,
  p_cash_state            text         default null,
  p_attempt_count         integer      default null,
  p_next_contact_at       timestamptz  default null,
  p_scheduled_for         timestamptz  default null,
  p_cancel_reason         text         default null,
  p_assigned_driver_id    uuid         default null,
  p_cancel_reasons        text[]       default null,
  p_clear_scheduled_for   boolean      default false,
  p_clear_cancel_reasons  boolean      default false,
  p_clear_assigned_driver boolean      default false,
  -- 0114 : deux corrections de date INDÉPENDANTES, chacune saisie au moment de sa
  -- propre transition. Passer l'une ne touche jamais la colonne de l'autre.
  p_call_confirmed_at     timestamptz  default null,
  p_delivered_at          timestamptz  default null
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order                     public.orders%rowtype;
  v_next_cash_state           text;
  v_next_delivery_state       text;
  v_next_order_state          text;
  v_next_status                text;
  v_payment_channel           text;
  v_transition_id             uuid;
  v_movement_type             text;
  v_effective_driver_id       uuid;
  v_cash_reversal_minor       bigint := 0;
  v_cash_reversal_method      text;
  v_cash_reversal_settlement  uuid;
  v_line                      record;
  v_assignment_line           record;
  v_assignment_release        record;
  v_advance_avail             integer;
  v_cover                     integer;
  v_remainder                 integer;
  -- 0114 — bornes de cohérence des deux dates éditables.
  v_order_origin_at           timestamptz;
  v_effective_confirmed_at    timestamptz;
  v_effective_delivered_at    timestamptz;
begin
  select *
    into v_order
    from public.orders
   where id = p_order_id
     for update;

  if not found then
    raise exception 'order_not_found'
      using errcode = 'P0002';
  end if;

  v_payment_channel     := coalesce(p_payment_channel, 'ESPECES');
  v_next_order_state    := coalesce(p_order_state,    v_order.order_state);
  v_next_delivery_state := coalesce(p_delivery_state, v_order.delivery_state);
  v_next_cash_state     := coalesce(p_cash_state,     v_order.cash_state);
  v_effective_driver_id := coalesce(p_assigned_driver_id, v_order.assigned_driver_id);

  if v_next_delivery_state = 'delivered'
     and v_next_cash_state = 'collected'
     and v_payment_channel not in (
       'ESPECES', 'WAVE', 'ORANGE_MONEY', 'FREE_MONEY', 'INCONNU'
     )
  then
    raise exception 'invalid_payment_channel'
      using errcode = '22023';
  end if;

  if v_next_order_state = 'returned' or v_next_delivery_state = 'returned' then
    if not (
      v_order.order_state = 'completed'
      and v_order.delivery_state = 'delivered'
      and v_next_order_state = 'returned'
      and v_next_delivery_state = 'returned'
    ) then
      raise exception 'illegal_return_transition'
        using errcode = '22023';
    end if;
  end if;

  -- 0114 — bornes de cohérence des deux dates éditables. Vérifiées ICI, dans l'unique
  -- porte d'écriture de l'état d'une commande : une saisie hors bornes est rejetée même
  -- si elle arrive par un appel RPC direct, pas seulement depuis le formulaire.
  if p_call_confirmed_at is not null or p_delivered_at is not null then
    -- Borne basse = origine réelle de la commande. Pour une commande Shopify importée
    -- après coup, `created_at` est la date d'IMPORT et peut être postérieure à la
    -- commande réelle (`created_at_shopify`) : borner sur `created_at` seul rejetterait
    -- des corrections légitimes. On prend donc la plus ancienne des deux, ce qui reste
    -- strictement « jamais avant la création de la commande ».
    v_order_origin_at := least(
      v_order.created_at,
      coalesce(v_order.created_at_shopify, v_order.created_at)
    );

    -- Tolérance de 5 minutes : l'horodatage vient d'un navigateur dont l'horloge peut
    -- devancer celle du serveur. Sans elle, une saisie « maintenant » serait rejetée.
    if greatest(
         coalesce(p_call_confirmed_at, '-infinity'::timestamptz),
         coalesce(p_delivered_at,      '-infinity'::timestamptz)
       ) > now() + interval '5 minutes'
    then
      raise exception 'invalid_date_future'
        using errcode = '22023';
    end if;

    if least(
         coalesce(p_call_confirmed_at, 'infinity'::timestamptz),
         coalesce(p_delivered_at,      'infinity'::timestamptz)
       ) < v_order_origin_at
    then
      raise exception 'invalid_date_before_creation'
        using errcode = '22023';
    end if;

    -- Confirmation ≤ livraison, quel que soit le sens de la saisie : corriger la
    -- confirmation d'une commande déjà livrée, ou corriger la livraison d'une commande
    -- déjà confirmée, sont tous les deux couverts par ce même test.
    v_effective_confirmed_at := coalesce(p_call_confirmed_at, v_order.call_confirmed_at);
    v_effective_delivered_at := coalesce(p_delivered_at,      v_order.cash_collected_at);

    if v_effective_confirmed_at is not null
       and v_effective_delivered_at is not null
       and v_effective_confirmed_at > v_effective_delivered_at
    then
      raise exception 'invalid_confirmation_after_delivery'
        using errcode = '22023';
    end if;
  end if;

  update public.orders
     set order_state    = coalesce(p_order_state,        order_state),
         call_state     = coalesce(p_call_state,          call_state),
         delivery_state = coalesce(p_delivery_state,      delivery_state),
         cash_state     = coalesce(p_cash_state,          cash_state),
         attempt_count  = coalesce(p_attempt_count,       attempt_count),
         next_contact_at = coalesce(p_next_contact_at,    next_contact_at),
         scheduled_for  = case
           when p_clear_scheduled_for then null
           else coalesce(p_scheduled_for, scheduled_for)
         end,
         cancel_reason  = case
           when p_clear_cancel_reasons then null
           when p_cancel_reasons is not null then p_cancel_reasons[1]
           else coalesce(p_cancel_reason, cancel_reason)
         end,
         cancel_reasons = case
           when p_clear_cancel_reasons then null
           else coalesce(p_cancel_reasons, cancel_reasons)
         end,
         assigned_driver_id = case
           when p_clear_assigned_driver then null
           else coalesce(p_assigned_driver_id, assigned_driver_id)
         end,
         payment_channel_at_delivery = case
           when v_next_delivery_state = 'delivered'
                and v_next_cash_state = 'collected'
             then v_payment_channel
           else payment_channel_at_delivery
         end,
         cash_collectable_minor = case
           when v_next_delivery_state <> 'delivered'
                or v_next_cash_state <> 'collected'
             then cash_collectable_minor
           when v_payment_channel in ('WAVE', 'ORANGE_MONEY', 'FREE_MONEY')
             then 0
           else round(total_amount)::bigint
         end,
         -- 0114 — date de confirmation client. Condition DIMENSIONNELLE (call_state
         -- devient 'validated'), pas une liste d'actions : couvre donc `confirmer` ET
         -- `programmer`, qui pose validated+scheduled en un seul geste et qui est le
         -- seul des deux réellement visible dans le menu. Même garde d'idempotence que
         -- cash_collected_at : une commande déjà confirmée ne voit jamais sa date
         -- réécrite par une transition ultérieure.
         call_confirmed_at = case
           when coalesce(p_call_state, v_order.call_state) = 'validated'
                and v_order.call_state <> 'validated'
                and call_confirmed_at is null
             then coalesce(p_call_confirmed_at, now())
           else call_confirmed_at
         end,
         -- 0114 — `p_delivered_at` (saisie explicite au moment de livrer) s'insère EN
         -- TÊTE du coalesce posé par 0096 : saisie utilisateur > scheduled_for > now().
         -- Le mécanisme PR #81 reste intact quand aucune saisie n'est faite.
         cash_collected_at = case
           when v_next_delivery_state = 'delivered'
                and v_next_cash_state = 'collected'
                and cash_collected_at is null
             then coalesce(p_delivered_at, v_order.scheduled_for, now())
           else cash_collected_at
         end,
         returned_at = case
           when p_order_state = 'returned'
                and v_order.order_state <> 'returned'
                and returned_at is null
             then now()
           else returned_at
         end,
         updated_at = now()
   where id = p_order_id
   returning cod_status into v_next_status;

  insert into public.order_state_transition (
    merchant_account_id,
    order_id,
    from_status,
    to_status,
    actor_user_id,
    note,
    created_at
  )
  values (
    v_order.merchant_account_id,
    v_order.id,
    v_order.cod_status,
    v_next_status,
    p_actor,
    p_note,
    now()
  )
  returning id into v_transition_id;

  if v_order.order_state = 'completed'
     and v_order.delivery_state = 'delivered'
     and v_next_order_state = 'returned'
     and v_next_delivery_state = 'returned'
  then
    select coalesce(sum(sa.allocated_minor), 0)
      into v_cash_reversal_minor
      from public.settlement_allocation sa
     where sa.order_id = v_order.id
       and sa.merchant_account_id = v_order.merchant_account_id;

    if v_cash_reversal_minor > 0 then
      if v_effective_driver_id is null then
        raise exception 'missing_driver_for_cash_reversal'
          using errcode = '22023';
      end if;

      v_cash_reversal_method := case
        when v_order.payment_channel_at_delivery in (
          'ESPECES', 'WAVE', 'ORANGE_MONEY', 'FREE_MONEY'
        )
          then v_order.payment_channel_at_delivery
        else 'ESPECES'
      end;

      insert into public.cash_settlement (
        merchant_account_id,
        driver_id,
        amount_received_minor,
        method,
        note,
        settled_at,
        created_by,
        client_request_id
      )
      values (
        v_order.merchant_account_id,
        v_effective_driver_id,
        -v_cash_reversal_minor,
        v_cash_reversal_method,
        'Reprise retour commande ' || coalesce(v_order.order_number, v_order.id::text),
        now(),
        p_actor,
        v_transition_id
      )
      returning id into v_cash_reversal_settlement;

      insert into public.settlement_allocation (
        settlement_id,
        order_id,
        allocated_minor,
        merchant_account_id
      )
      values (
        v_cash_reversal_settlement,
        v_order.id,
        -v_cash_reversal_minor,
        v_order.merchant_account_id
      );
    end if;
  end if;

  v_movement_type := case
    when v_next_delivery_state in ('assigned', 'out_for_delivery')
         and v_order.delivery_state not in (
           'assigned', 'out_for_delivery', 'delivered', 'failed', 'returned'
         )
      then 'dispatch'

    when v_next_delivery_state = 'delivered'
         and v_order.delivery_state <> 'delivered'
      then 'sold'

    when v_next_order_state = 'returned'
         and v_next_delivery_state = 'returned'
         and v_order.order_state = 'completed'
         and v_order.delivery_state = 'delivered'
      then 'courier_return'

    when coalesce(p_call_state, v_order.call_state) = 'validated'
         and v_order.call_state <> 'validated'
         and v_next_delivery_state in ('unassigned', 'scheduled')
      then 'reserve'

    when coalesce(p_call_state, v_order.call_state) = 'to_call'
         and v_order.call_state = 'validated'
         and v_order.order_state = 'open'
         and v_order.delivery_state in ('unassigned', 'scheduled')
      then 'release'

    when v_next_order_state in ('cancelled', 'returned')
         and v_order.order_state not in ('cancelled', 'returned')
         and v_order.delivery_state in ('unassigned', 'scheduled')
      then 'release'

    else null
  end;

  if v_movement_type is not null then
    for v_line in
      select ol.id, ol.product_id, ol.qty
        from public.order_line ol
       where ol.order_id  = p_order_id
         and ol.match_status = 'matched'
         and ol.product_id   is not null
    loop
      if v_movement_type = 'dispatch' then
        select greatest(0,
            coalesce(sum(case when sm.movement_type = 'allocate_to_courier' then -sm.qty else 0 end), 0)
          - coalesce(sum(case when sm.movement_type = 'courier_return_lot'   then  sm.qty else 0 end), 0)
          - coalesce(sum(case when sm.movement_type = 'advance_commit'       then  sm.qty else 0 end), 0)
        )
          into v_advance_avail
          from public.stock_movement sm
         where sm.merchant_account_id = v_order.merchant_account_id
           and sm.product_id = v_line.product_id
           and sm.driver_id  = v_effective_driver_id;

        v_cover     := least(v_line.qty, coalesce(v_advance_avail, 0));
        v_remainder := v_line.qty - v_cover;

        if v_cover > 0 then
          perform public.post_stock_movement(
            p_merchant_account_id := v_order.merchant_account_id,
            p_product_id          := v_line.product_id,
            p_movement_type       := 'advance_commit',
            p_qty                 := v_cover,
            p_idempotency_key     := v_transition_id::text
                                     || ':' || v_line.id::text
                                     || ':advance_commit',
            p_created_by          := p_actor,
            p_order_id            := p_order_id,
            p_transition_id       := v_transition_id,
            p_driver_id           := v_effective_driver_id
          );
        end if;

        if v_remainder > 0 then
          perform public.post_stock_movement(
            p_merchant_account_id := v_order.merchant_account_id,
            p_product_id          := v_line.product_id,
            p_movement_type       := 'dispatch',
            p_qty                 := -v_remainder,
            p_idempotency_key     := v_transition_id::text
                                     || ':' || v_line.id::text
                                     || ':dispatch',
            p_created_by          := p_actor,
            p_order_id            := p_order_id,
            p_transition_id       := v_transition_id,
            p_driver_id           := v_effective_driver_id
          );
        end if;

      else
        perform public.post_stock_movement(
          p_merchant_account_id := v_order.merchant_account_id,
          p_product_id          := v_line.product_id,
          p_movement_type       := v_movement_type,
          p_qty                 := case
                                     when v_movement_type = 'release'
                                       then -v_line.qty
                                     else v_line.qty
                                   end,
          p_idempotency_key     := v_transition_id::text
                                   || ':' || v_line.id::text
                                   || ':' || v_movement_type,
          p_created_by          := p_actor,
          p_order_id            := p_order_id,
          p_transition_id       := v_transition_id,
          p_driver_id           := v_effective_driver_id
        );
      end if;
    end loop;
  end if;

  -- Availability commit is grouped by product because order_line does not have
  -- a unique (order_id, product_id) constraint.
  if v_movement_type = 'dispatch' then
    for v_assignment_line in
      select ol.product_id, sum(ol.qty)::integer as qty
        from public.order_line ol
       where ol.order_id = p_order_id
         and ol.match_status = 'matched'
         and ol.product_id is not null
       group by ol.product_id
    loop
      perform public.post_stock_movement(
        p_merchant_account_id := v_order.merchant_account_id,
        p_product_id          := v_assignment_line.product_id,
        p_movement_type       := 'order_assignment_commit',
        p_qty                 := v_assignment_line.qty,
        p_idempotency_key     := v_transition_id::text
                                 || ':' || v_assignment_line.product_id::text
                                 || ':order_assignment_commit',
        p_created_by          := p_actor,
        p_order_id            := p_order_id,
        p_transition_id       := v_transition_id,
        p_driver_id           := v_effective_driver_id
      );
    end loop;
  end if;

  -- Availability releases are targeted from the ledger, not from orders.assigned_driver_id.
  -- The release quantity is capped to min(required_qty, net_open) per product+driver.
  -- 0109 : `required` résout bundle→composants (0107/0108) — la même granularité que le
  -- ledger, qui contient désormais des mouvements par COMPOSANT pour un bundle, jamais par
  -- bundle lui-même. Sans ce fix, `required` (product_id = bundle) ne matchait jamais
  -- `open_commitments` (product_id = composant) pour une order_line bundle.
  if (
       v_next_order_state in ('cancelled', 'returned')
       and v_order.order_state not in ('cancelled', 'returned')
     )
     or (
       v_next_order_state = 'open'
       and v_order.order_state = 'open'
       and v_order.delivery_state in ('assigned', 'out_for_delivery')
       and v_next_delivery_state = 'scheduled'
     )
  then
    for v_assignment_release in
      with required as (
        select product_id, required_qty
          from public.resolve_order_required_component_quantities(p_order_id)
      ),
      open_commitments as (
        select sm.product_id,
               sm.driver_id,
               sum(case
                 when sm.movement_type = 'order_assignment_commit' then sm.qty
                 when sm.movement_type = 'order_assignment_release' then -abs(sm.qty)
                 else 0
               end)::integer as net_open
          from public.stock_movement sm
         where sm.merchant_account_id = v_order.merchant_account_id
           and sm.order_id = p_order_id
           and sm.driver_id is not null
           and sm.movement_type in ('order_assignment_commit', 'order_assignment_release')
         group by sm.product_id, sm.driver_id
        having sum(case
          when sm.movement_type = 'order_assignment_commit' then sm.qty
          when sm.movement_type = 'order_assignment_release' then -abs(sm.qty)
          else 0
        end) > 0
      )
      select oc.product_id,
             oc.driver_id,
             least(r.required_qty, oc.net_open)::integer as qty
        from open_commitments oc
        join required r on r.product_id = oc.product_id
       where least(r.required_qty, oc.net_open) > 0
    loop
      perform public.post_stock_movement(
        p_merchant_account_id := v_order.merchant_account_id,
        p_product_id          := v_assignment_release.product_id,
        p_movement_type       := 'order_assignment_release',
        p_qty                 := -v_assignment_release.qty,
        p_idempotency_key     := v_transition_id::text
                                 || ':' || v_assignment_release.product_id::text
                                 || ':' || v_assignment_release.driver_id::text
                                 || ':order_assignment_release',
        p_created_by          := p_actor,
        p_order_id            := p_order_id,
        p_transition_id       := v_transition_id,
        p_driver_id           := v_assignment_release.driver_id
      );
    end loop;
  end if;

  if p_clear_assigned_driver then
    for v_line in
      select sm.product_id,
             sm.driver_id,
             sum(sm.qty)::integer as committed
        from public.stock_movement sm
       where sm.order_id = p_order_id
         and sm.merchant_account_id = v_order.merchant_account_id
         and sm.movement_type = 'advance_commit'
         and sm.driver_id is not null
       group by sm.product_id, sm.driver_id
      having sum(sm.qty) <> 0
    loop
      perform public.post_stock_movement(
        p_merchant_account_id := v_order.merchant_account_id,
        p_product_id          := v_line.product_id,
        p_movement_type       := 'advance_commit',
        p_qty                 := -v_line.committed,
        p_idempotency_key     := v_transition_id::text
                                 || ':' || v_line.product_id::text
                                 || ':' || v_line.driver_id::text
                                 || ':advance_commit_reversal',
        p_created_by          := p_actor,
        p_order_id            := p_order_id,
        p_transition_id       := v_transition_id,
        p_driver_id           := v_line.driver_id
      );
    end loop;
  end if;

  return v_next_status;
end;
$$;

-- Un DROP + CREATE crée une fonction NEUVE : elle repart avec le EXECUTE par défaut à
-- PUBLIC, et les privilèges posés en 0067/0091 sur l'ancienne signature ne s'y appliquent
-- pas (leçon explicite de 0067, qui existe uniquement parce que 0066 avait oublié ce
-- point). On rétablit donc le même verrouillage sur la NOUVELLE signature à 19 arguments.
revoke all on function public.transition_order(
  uuid, uuid, text, text, text, text, text, text,
  integer, timestamptz, timestamptz, text, uuid,
  text[], boolean, boolean, boolean, timestamptz, timestamptz
) from public, anon;

grant execute on function public.transition_order(
  uuid, uuid, text, text, text, text, text, text,
  integer, timestamptz, timestamptz, text, uuid,
  text[], boolean, boolean, boolean, timestamptz, timestamptz
) to authenticated;
