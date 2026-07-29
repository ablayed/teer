-- 0116 : « Invalider une commande » — une commande LIVREE revient à l'état initial
-- « À appeler », comme si elle n'avait jamais été traitée.
--
-- CONTEXTE / DÉCISION PRODUIT
-- Une commande peut être marquée livrée par erreur (mauvaise ligne cliquée, livreur qui
-- annonce une livraison qui n'a pas eu lieu). Jusqu'ici LIVREE était terminale : la seule
-- sortie était « Marquer retournée » (REFUSEE), qui enregistre un RETOUR — un fait métier
-- différent, qui pollue les taux de retour/RTO. « Invalider » dit l'inverse : la livraison
-- n'a jamais eu lieu, la commande repart au tout début du tunnel.
--
-- L'effet rétroactif est VOULU : `cash_collected_at` et `call_confirmed_at` sont remis à
-- NULL, la commande sort donc naturellement des fenêtres de tous les rapports (CA encaissé,
-- Livraisons par produit, P&L, cash livreur) — aucun rapport n'est corrigé à la main, ils
-- recalculent simplement sans elle. Conséquence assumée : un mois déjà consulté par le
-- marchand peut voir son CA baisser rétroactivement.
--
-- 1) NOUVEAU PARAMÈTRE `p_invalidate_delivered boolean default false`.
--    L'invalidation n'est PAS déduite des dimensions. Elle est demandée explicitement :
--    c'est la seule branche de cette fonction qui EFFACE des données financières déjà
--    posées (`cash_collected_at`) et qui contre-passe des mouvements de stock. Un flag
--    explicite la rend impossible à déclencher par accident depuis un autre chemin dont
--    les dimensions se rapprocheraient un jour de cette signature.
--
-- 2) GARDE D'ÉTAT : `p_invalidate_delivered` n'est acceptée que sur une commande
--    réellement livrée (`order_state='completed'` ET `delivery_state='delivered'`).
--    Sinon `illegal_invalidation`.
--
-- 3) GARDE FINANCIÈRE — cash déjà remis au bureau (`cash_state in ('remitted',
--    'discrepancy')`) : l'invalidation est REFUSÉE (`invalid_invalidate_cash_settled`).
--    Ce n'est pas une précaution de principe, c'est un trou de réconciliation concret :
--    un cash remis a produit des lignes `cash_settlement` + `settlement_allocation`
--    (argent physiquement reçu). Or `get_driver_cash_consolidation` (0100) rattache TOUT,
--    collecté comme remis, via `orders.assigned_driver_id`, que l'invalidation vide —
--    l'encaissement ET la remise disparaîtraient ensemble de la vue livreur pendant que
--    les lignes `cash_settlement` continueraient d'exister, sans contre-passation.
--    « Marquer retournée » sait faire cette contre-passation (elle poste un
--    `cash_settlement` négatif, cf. bloc `v_cash_reversal_minor` plus bas) ; l'invalidation
--    non, et lui greffer une reprise de cash reviendrait à trancher une question de
--    remboursement qui n'appartient pas à ce lot. Aggravant décisif : cette action
--    n'écrit AUCUN audit (décision produit, cf. CLAUDE.md), un écart financier introduit
--    ici serait donc strictement introuvable après coup. Le cas `cash_state='collected'`
--    (livré, argent encore chez le livreur, aucun versement enregistré) reste AUTORISÉ :
--    aucune ligne `cash_settlement` n'existe, il n'y a rien à désynchroniser.
--
-- 4) CHAMPS REMIS À ZÉRO dans l'UPDATE, en plus des 4 dimensions passées par l'appelant :
--    `cash_collected_at`, `call_confirmed_at` (les deux dates de 0114),
--    `payment_channel_at_delivery` et `cash_collectable_minor`. Ces deux derniers sont
--    lus par `get_driver_cash_consolidation` (coalesce de repli sur le canal de paiement) :
--    les laisser en place ferait survivre un montant encaissable fantôme sur une commande
--    « jamais livrée ».
--
-- 5) CONTRE-PASSATION DE STOCK — par NÉGATION EXACTE, dérivée du LEDGER, pas d'`order_line`.
--    Principe : pour chaque (produit, livreur, type) réellement posé sur cette commande, on
--    poste le MÊME type avec la quantité nette OPPOSÉE. Toute grandeur dérivée par simple
--    somme du ledger (stock en main livreur, stock disponible, COGS `sold`, métriques IA)
--    retombe donc exactement à sa valeur d'avant, par construction — sans énumérer ses
--    consommateurs.
--      • `dispatch`  → `dispatch` opposé : rend le stock au central (`qty_on_hand`).
--      • `sold`      → `sold` opposé : annule la vente (COGS, et rend la marchandise en
--                      main du livreur avant qu'elle ne reparte au central).
--      • `reassign_from_driver` / `reassign_to_driver` → opposés : sans eux, une commande
--                      réassignée verrait la contre-passation atterrir sur le mauvais
--                      livreur (dispatch posté au livreur d'origine, `sold` au livreur final).
--    Pourquoi PAS un `courier_return` (le type qu'utilise « Marquer retournée ») : aucun
--    retour n'a eu lieu. `courier_return` est lu comme un signal de RETOUR par la finance
--    et par `lib/ia/finance-data.ts` — l'émettre ici fabriquerait un retour qui n'existe pas.
--    Un `release` APPARIÉ au dispatch contre-passé neutralise l'effet de bord de `dispatch`
--    sur `qty_reserved` (post_stock_movement fait `qty_reserved + qty` pour ce type) : le
--    `reserve` d'origine avait déjà été entièrement consommé par le dispatch, le réserver à
--    nouveau serait faux. Le `reserve` d'origine n'est donc volontairement PAS contre-passé.
--      • `order_assignment_commit` → le bloc `order_assignment_release` EXISTANT est réutilisé
--        tel quel (sa condition gagne le cas invalidation) : il cible depuis le ledger et
--        plafonne à `least(required_qty, net_open)`, donc structurellement incapable de
--        sur-libérer.
--      • `advance_commit` → contre-passé par le bloc `p_clear_assigned_driver` EXISTANT,
--        déclenché puisque l'invalidation vide le livreur. Asymétrie connue et inchangée :
--        un `advance_commit` négatif ne restaure pas `qty_reserved` (`greatest(p_qty, 0)`) —
--        c'est sans effet ici, le calcul détaillé montrant que `qty_reserved` retombe bien
--        à sa valeur d'origine avec ou sans stock d'avance.
--
-- 6) AUCUN `audit_log` — décision produit explicite du porteur, exception assumée à la
--    convention du projet. Rien à faire ici : `transition_order` n'a jamais écrit
--    `audit_log` (c'est `lib/actions/transitions.ts` qui le fait) ; c'est donc côté TS que
--    l'exception est implémentée, et documentée dans CLAUDE.md.
--    La ligne `order_state_transition` reste posée : ce n'est pas une trace d'audit mais
--    l'ancre d'idempotence des mouvements de stock (`p_transition_id` alimente toutes les
--    clés d'idempotence ci-dessous) — la retirer casserait la contre-passation elle-même.
--
-- PORTÉE : signature (+1 paramètre), 2 gardes, 4 colonnes de l'UPDATE, 1 condition élargie
-- et 1 boucle de contre-passation. Tout le reste de `transition_order` est repris VERBATIM
-- de `0114` (fichier copié puis patché, à vérifier par `diff` avant merge).
-- « Marquer retournée » n'est PAS touchée : ni sa branche de reprise de cash, ni son
-- `courier_return`, ni sa garde `illegal_return_transition`.

-- AUCUNE colonne ajoutée par cette migration : `call_confirmed_at` existe déjà (0114),
-- l'invalidation ne fait que la remettre à NULL.

-- La signature change (+1 paramètre) : un `create or replace` créerait une SURCHARGE au
-- lieu de remplacer, et les deux versions coexisteraient. On DROP donc explicitement la
-- signature à 19 arguments de 0114 avant de recréer.
drop function if exists public.transition_order(
  uuid, uuid, text, text, text, text, text, text, integer, timestamptz, timestamptz,
  text, uuid, text[], boolean, boolean, boolean, timestamptz, timestamptz
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
  p_delivered_at          timestamptz  default null,
  -- 0116 : demande EXPLICITE d'invalidation d'une commande livrée. Jamais déduite des
  -- dimensions — c'est la seule branche qui efface des données financières déjà posées.
  p_invalidate_delivered  boolean      default false
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
  -- 0116 — contre-passation de stock à l'invalidation.
  v_invalidation_reversal     record;
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

  -- 0116 — gardes de l'invalidation. Vérifiées ICI, dans l'unique porte d'écriture de
  -- l'état d'une commande : elles tiennent même face à un appel RPC direct, pas seulement
  -- depuis le menu. Les deux sont placées AVANT l'UPDATE : une invalidation refusée ne
  -- laisse aucune écriture partielle derrière elle.
  if p_invalidate_delivered then
    if v_order.order_state <> 'completed' or v_order.delivery_state <> 'delivered' then
      raise exception 'illegal_invalidation'
        using errcode = '22023';
    end if;

    -- Cash déjà remis (ou en écart) : des lignes cash_settlement/settlement_allocation
    -- existent, l'argent a physiquement changé de mains. L'invalidation n'a aucun
    -- mécanisme de contre-passation de cash (contrairement à « Marquer retournée ») et
    -- ne laisse aucune trace d'audit : on refuse plutôt que de désynchroniser en silence.
    if v_order.cash_state in ('remitted', 'discrepancy') then
      raise exception 'invalid_invalidate_cash_settled'
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
         -- 0116 : à l'invalidation, le canal de paiement et le montant encaissable de la
         -- livraison sont effacés — ils sont lus en repli par get_driver_cash_consolidation
         -- (0100) et survivraient sinon en montant fantôme sur une commande « jamais livrée ».
         payment_channel_at_delivery = case
           when p_invalidate_delivered then null
           when v_next_delivery_state = 'delivered'
                and v_next_cash_state = 'collected'
             then v_payment_channel
           else payment_channel_at_delivery
         end,
         cash_collectable_minor = case
           when p_invalidate_delivered then 0
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
           -- 0116 : l'invalidation remet la commande « jamais confirmée, jamais livrée ».
           -- Cette remise à NULL est ce qui fait sortir la commande des fenêtres de tous
           -- les rapports, qui recalculent alors sans elle sans aucune correction manuelle.
           when p_invalidate_delivered then null
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
           -- 0116 : idem — c'est la colonne que lisent le CA encaissé du Tableau, les
           -- Livraisons par produit et tout le P&L Finances.
           when p_invalidate_delivered then null
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
     -- 0116 : l'invalidation libère elle aussi l'engagement de disponibilité du livreur.
     -- Elle réutilise ce bloc TEL QUEL plutôt que d'en dupliquer un : le ciblage part du
     -- ledger (jamais d'orders.assigned_driver_id) et plafonne à least(required, net_open),
     -- il est donc structurellement incapable de sur-libérer.
     or p_invalidate_delivered
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

  -- 0116 — contre-passation de stock de l'invalidation, par NÉGATION EXACTE dérivée du
  -- LEDGER (jamais d'order_line). Rejouer order_line serait faux dans deux cas réels :
  -- un dispatch partiellement couvert par du stock d'avance (advance_commit) rendrait trop
  -- de stock au central, et une commande réassignée verrait la contre-passation atterrir
  -- sur le mauvais livreur. Le ledger, lui, dit exactement ce qui a été posé et pour qui.
  --
  -- Les lignes de ledger d'un bundle sont DÉJÀ à la granularité composant (cascade de
  -- post_stock_movement, 0108) : les rejouer ne re-cascade pas (un composant ne peut pas
  -- être lui-même un bundle, contrainte 0107) — la cascade bundle est donc gérée sans
  -- aucun code dédié ici.
  if p_invalidate_delivered then
    for v_invalidation_reversal in
      select sm.product_id,
             sm.driver_id,
             sm.movement_type,
             sum(sm.qty)::integer as net_qty
        from public.stock_movement sm
       where sm.order_id = p_order_id
         and sm.merchant_account_id = v_order.merchant_account_id
         and sm.movement_type in (
           'dispatch', 'sold', 'reassign_from_driver', 'reassign_to_driver'
         )
       group by sm.product_id, sm.driver_id, sm.movement_type
      having sum(sm.qty) <> 0
    loop
      perform public.post_stock_movement(
        p_merchant_account_id := v_order.merchant_account_id,
        p_product_id          := v_invalidation_reversal.product_id,
        p_movement_type       := v_invalidation_reversal.movement_type,
        p_qty                 := -v_invalidation_reversal.net_qty,
        p_idempotency_key     := v_transition_id::text
                                 || ':' || v_invalidation_reversal.product_id::text
                                 || ':' || coalesce(v_invalidation_reversal.driver_id::text, 'none')
                                 || ':' || v_invalidation_reversal.movement_type
                                 || ':invalidate_reversal',
        p_created_by          := p_actor,
        p_order_id            := p_order_id,
        p_transition_id       := v_transition_id,
        p_driver_id           := v_invalidation_reversal.driver_id
      );

      -- `dispatch` mute qty_on_hand ET qty_reserved (post_stock_movement). Contre-passer
      -- le dispatch rend bien le stock au central, mais RÉ-ARME aussi la réserve — alors
      -- que le `reserve` d'origine avait déjà été entièrement consommé par ce dispatch.
      -- Ce `release` apparié annule ce seul effet de bord ; c'est aussi pourquoi le
      -- `reserve` d'origine n'est volontairement pas contre-passé.
      if v_invalidation_reversal.movement_type = 'dispatch' then
        perform public.post_stock_movement(
          p_merchant_account_id := v_order.merchant_account_id,
          p_product_id          := v_invalidation_reversal.product_id,
          p_movement_type       := 'release',
          p_qty                 := v_invalidation_reversal.net_qty,
          p_idempotency_key     := v_transition_id::text
                                   || ':' || v_invalidation_reversal.product_id::text
                                   || ':' || coalesce(v_invalidation_reversal.driver_id::text, 'none')
                                   || ':invalidate_reserved_release',
          p_created_by          := p_actor,
          p_order_id            := p_order_id,
          p_transition_id       := v_transition_id,
          p_driver_id           := v_invalidation_reversal.driver_id
        );
      end if;
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
-- PUBLIC, et les privilèges posés en 0067/0091/0114 sur l'ancienne signature ne s'y
-- appliquent pas (leçon explicite de 0067, qui existe uniquement parce que 0066 avait
-- oublié ce point). On rétablit donc le même verrouillage sur la NOUVELLE signature à
-- 20 arguments.
revoke all on function public.transition_order(
  uuid, uuid, text, text, text, text, text, text,
  integer, timestamptz, timestamptz, text, uuid,
  text[], boolean, boolean, boolean, timestamptz, timestamptz, boolean
) from public, anon;

grant execute on function public.transition_order(
  uuid, uuid, text, text, text, text, text, text,
  integer, timestamptz, timestamptz, text, uuid,
  text[], boolean, boolean, boolean, timestamptz, timestamptz, boolean
) to authenticated;
