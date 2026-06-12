-- ============================================================
-- 0055 : Lot B (suite) - rendre scheduled_for / cancel_reason effaçables
-- ============================================================
-- Contexte :
--   0054 a ajouté à transition_order des FLAGS d'effacement
--   (p_clear_scheduled_for / p_clear_cancel_reasons) pour que déconfirmer et
--   désannuler puissent remettre scheduled_for et cancel_reason(s) à NULL.
--
--   MAIS le trigger BEFORE INSERT OR UPDATE `orders_sync_legacy_cod_status`
--   (0023) ré-écrit ces colonnes en :
--       new.scheduled_for := coalesce(new.scheduled_for, old.scheduled_for);
--       new.cancel_reason := coalesce(new.cancel_reason, old.cancel_reason);
--   → tout NULL explicite est restauré à l'ancienne valeur. Les clears de
--   0054 étaient donc silencieusement annulés (prouvé par le test RLS Lot B :
--   cancel_reasons passait bien à NULL — colonne hors trigger — mais
--   cancel_reason restait 'prix' et scheduled_for ne pouvait pas se vider).
--
-- CORRECTIF (ce fichier) : redéfinir le trigger pour laisser l'ÉCRIVAIN
--   (transition_order, seul write-gate des dimensions) contrôler pleinement
--   ces deux colonnes :
--     * scheduled_for : on retire le coalesce. Un UPDATE qui ne touche pas la
--       colonne garde l'ancienne valeur (NEW = OLD en BEFORE UPDATE) ; un clear
--       explicite (NULL) est désormais respecté.
--     * cancel_reason : devient un MIROIR de cancel_reasons (source Lot B) —
--       cancel_reasons[1] si présent, sinon la valeur posée par l'écrivain
--       (permet le clear ET les marqueurs legacy 'refused' du refus, qui
--       n'utilise pas cancel_reasons).
--
-- INVARIANT DUAL-WRITE INTACT : la dérivation de cod_status
--   (derive_legacy_cod_status sur les 4 dimensions) est BYTE-POUR-BYTE
--   identique. Seules les lignes auxiliaires scheduled_for / cancel_reason
--   changent → reconcile_order_cod_status() reste à zéro écart.
--
-- Aucune RLS / table / colonne modifiée : on remplace UNE fonction trigger.
-- ============================================================

create or replace function public.orders_sync_legacy_cod_status()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  new.order_state := coalesce(new.order_state, old.order_state, 'open');
  new.call_state := coalesce(new.call_state, old.call_state, 'to_call');
  new.delivery_state := coalesce(new.delivery_state, old.delivery_state, 'unassigned');
  new.cash_state := coalesce(new.cash_state, old.cash_state, 'not_due');
  new.attempt_count := coalesce(new.attempt_count, old.attempt_count, 0);
  new.next_contact_at := coalesce(new.next_contact_at, old.next_contact_at);

  -- Lot B : scheduled_for pleinement contrôlé par l'écrivain (clear possible).
  -- Plus de coalesce(new, old) : un UPDATE qui ne touche pas la colonne a déjà
  -- NEW = OLD (BEFORE UPDATE) ; un clear explicite à NULL est respecté.

  -- Lot B : cancel_reason = miroir de cancel_reasons (source). Quand
  -- cancel_reasons est renseigné → 1ᵉʳ élément ; sinon on garde la valeur posée
  -- par l'écrivain (autorise le clear à NULL ET le marqueur legacy 'refused').
  new.cancel_reason := case
    when new.cancel_reasons is not null and array_length(new.cancel_reasons, 1) >= 1
      then new.cancel_reasons[1]
    else new.cancel_reason
  end;

  new.cod_status := public.derive_legacy_cod_status(
    new.order_state,
    new.call_state,
    new.delivery_state,
    new.cash_state
  );

  return new;
end;
$$;
