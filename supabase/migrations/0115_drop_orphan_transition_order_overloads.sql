-- 0115 : suppression des deux surcharges orphelines de public.transition_order.
--
-- CONTEXTE
-- `public.transition_order` avait TROIS surcharges vivantes en base. Les deux plus
-- anciennes datent d'avant le passage au modèle à 4 dimensions (order_state, call_state,
-- delivery_state, cash_state) et écrivent encore `cod_status` en direct, ce que le projet
-- interdit explicitement depuis que ce champ est dérivé par trigger :
--
--   (p_order_id uuid, p_to text, p_actor uuid, p_note text)
--   (p_order_id uuid, p_to text, p_actor uuid, p_note text, p_payment_channel text)
--
-- POURQUOI LES SUPPRIMER
-- 1) `EXECUTE` leur est encore accordé à `anon`. Le `revoke all … from public, anon` de
--    `0067` ne visait que la signature de son époque : ces deux-là ne l'ont jamais reçu.
--    Un client NON AUTHENTIFIÉ peut donc faire exécuter du PL/pgSQL qui touche `orders`,
--    `order_state_transition` et, indirectement, la cascade de stock.
--
--    ⚠️ Ce n'est PAS une vulnérabilité exploitable en l'état, et la migration ne doit pas
--    être présentée comme un correctif d'incident. Vérifié empiriquement avant écriture,
--    par un vrai appel HTTP avec la clé `anon` (pas une déduction) : la fonction est
--    `security invoker`, RLS s'applique donc pleinement, son premier `select … for update`
--    ne voit aucune ligne et elle lève `order_not_found` avant toute écriture. Comptages
--    relevés en base après l'appel : `order_state_transition` 3045 → 3045,
--    `stock_movement` 3614 → 3614, `orders.updated_at` inchangé. Zéro ligne écrite.
--    C'est une surface d'exécution inutile qu'on retire par défense en profondeur, dans un
--    projet dont la sécurité a toujours reposé sur plusieurs couches (RBAC applicatif +
--    RLS + gardes NULL-safe), jamais sur une seule.
--
-- 2) Elles sont inertes même pour un rôle autorisé. Elles n'écrivent que `cod_status`, que
--    le trigger `derive_legacy_cod_status` recalcule aussitôt depuis les 4 dimensions —
--    qu'elles ne touchent pas. Un owner/manager qui les appellerait ne changerait donc
--    aucun état, mais insérerait une ligne `order_state_transition` incohérente, polluant
--    un historique que plusieurs compteurs lisent (`taux_confirmation`,
--    `get_dashboard_priority_counts`).
--
-- 3) La surcharge à 4 arguments est de toute façon INATTEIGNABLE : tout appel qui lui
--    correspond correspond aussi à celle à 5 arguments (son 5ᵉ paramètre a un défaut).
--    PostgreSQL répond `42725 function is not unique`, PostgREST `PGRST203`. Vérifié en
--    positionnel ET en arguments nommés.
--
-- AUCUN APPELANT — vérifié avant écriture, pas supposé :
--   • code applicatif : le seul appelant est `lib/actions/transitions.ts`, qui passe des
--     arguments nommés du modèle à 4 dimensions (`p_call_state`, `p_delivery_state`, …) et
--     résout donc exclusivement la signature courante à 19 arguments ;
--   • aucun `p_to:` dans un appel `transition_order` du dépôt ;
--   • aucune fonction SQL ni trigger n'exécute `perform`/`select public.transition_order` ;
--   • aucun test ne les référence.
--
-- PORTÉE : suppression pure. La signature courante à 19 arguments (`0114`) n'est pas
-- touchée, ses privilèges non plus — un `drop` par signature exacte n'affecte que la
-- surcharge visée. Aucune table, aucune policy, aucun grant modifié.

drop function if exists public.transition_order(
  uuid, text, uuid, text
);

drop function if exists public.transition_order(
  uuid, text, uuid, text, text
);
