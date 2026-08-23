-- ============================================================
-- 0140 : ferme les EXECUTE ouverts à PUBLIC/anon — 3 fonctions mortes
-- + 15 fonctions vivantes jamais fermées à anon depuis leur création
-- ============================================================
-- Contexte (audit Lot F, préalable Lot final Phase 1) : DEUX mécanismes
-- distincts laissent une fonction exécutable par anon, et un audit qui ne
-- vérifie que le texte des migrations rate systématiquement l'un des deux :
--
--   (1) PostgreSQL accorde EXECUTE à PUBLIC par défaut sur toute fonction
--       nouvellement CREATE, et un DROP FUNCTION + CREATE FUNCTION repart de
--       zéro (les revoke/grant portant sur l'ANCIENNE signature ne
--       s'appliquent pas à la nouvelle — leçon 0067). `revoke ... from anon`
--       SEUL ne suffit pas ici : l'accès vient de PUBLIC, pas d'un grant
--       nommé à anon — il faut `revoke ... from public`.
--
--   (2) Ce projet tourne sur Supabase, dont le bootstrap de plateforme
--       accorde EXECUTE nommément à anon, authenticated ET service_role sur
--       toute fonction créée dans public — PAS via le pseudo-rôle PUBLIC.
--       `revoke ... from public` SEUL est alors un NO-OP silencieux : rien
--       n'a jamais été accordé à PUBLIC, donc rien n'est retiré, et anon
--       garde son accès. Il faut `revoke ... from anon` explicitement.
--
-- Une migration qui ne fait QUE `revoke ... from public` (sans anon) a
-- l'AIR fermée en texte tout en restant grande ouverte en ACL réelle si
-- c'est le mécanisme (2) qui s'applique. C'est ce qui a fait rater
-- `ia_count_recent_tool_calls`/`ia_finance_cost_movements`/`ia_product_cump`/
-- `log_ia_tool_audit`/`purge_pcd_access_audit` à un premier balayage
-- textuel : leurs migrations d'origine (0040/0041/0123) contenaient bien un
-- `revoke ... from public`, mais jamais `from anon` — inefficace contre le
-- mécanisme (2). Inversement, `reassign_order_driver` a reçu un
-- `revoke ... from anon` en 0139 qui n'a RIEN retiré, parce que son
-- exposition venait du mécanisme (1) (jamais de grant nommé à anon,
-- seulement le défaut PUBLIC jamais revoke).
--
-- **Seule `pg_proc.proacl` (l'ACL réelle en base) fait foi — jamais la
-- présence d'une instruction `revoke` dans le texte d'une migration.**
-- Vérifié avant/après par requête directe sur `pg_proc.proacl`, pas déduit
-- du SQL. D'où la règle, désormais ceinture-et-bretelles pour toute future
-- fermeture : `revoke all on function ... from public, anon;` — les DEUX
-- grantees nommés, systématiquement, jamais l'un sans l'autre.
--
-- Balayage complet par ACL réelle (pas par texte de migration) : 15
-- fonctions non-trigger vivantes sont exécutables par anon aujourd'hui
-- (dont `get_customer_reliability`, exposée depuis `0014`, à travers le
-- `DROP + CREATE` de `0049`), + list_orders_paginated/orders_view_counts
-- déjà revoke correctement de public/anon (0062) mais toujours accessibles
-- à `authenticated` alors qu'elles sont mortes, + list_customer_reliability
-- morte et jamais fermée du tout.
--
-- Aucune fuite de données prouvée sur AUCUNE des 15 fonctions vivantes —
-- chacune testée EMPIRIQUEMENT en rôle anon (transaction ouverte, IDs
-- réels de seed, ROLLBACK) : `get_customer_reliability` et
-- `reassign_order_driver` renvoient 0 ligne / échouent sur `order_not_found`
-- (RLS + grants table bloquent avant même l'évaluation de policy, zéro
-- mutation confirmée après coup) ; `ia_finance_cost_movements`/
-- `ia_product_cump` ont une garde de rôle NULL-safe (fix `0042`,
-- incident historique déjà documenté) ; `ia_count_recent_tool_calls`/
-- `log_ia_tool_audit` vérifient `auth.uid() is null` en premier ;
-- `purge_pcd_access_audit` refuse explicitement (`auth.role() <> 'service_role'`,
-- confirmé par exception `42501` réelle) ; `sn_phone_e164` est une fonction
-- pure sans accès table. C'est une fermeture de surface d'attaque, pas un
-- correctif d'incident.
--
-- Quatre groupes :
--
--   A. MORTES (zéro appelant TS/SQL/E2E confirmé) → revoke total, y compris
--      authenticated. list_orders_paginated/orders_view_counts : dette déjà
--      documentée (CLAUDE.md, audit performance) ; list_customer_reliability :
--      même famille cross join lateral, prédécesseur direct de
--      list_store_customer_reliability (0132).
--
--   B. VIVANTES avec déjà un grant explicite à `authenticated` posé par une
--      migration antérieure (cash_aging 0017, receive_purchase_lot 0034,
--      resolve_order_required_component_quantities 0109, get_customer_reliability
--      0049) → revoke from public, anon SEULEMENT. Le grant authenticated
--      existant n'est pas touché (REVOKE ne retire que les privilèges du
--      grantee ciblé).
--
--   C. VIVANTES qui n'ont JAMAIS reçu le moindre grant explicite (reposent
--      intégralement sur le défaut PUBLIC depuis leur toute première
--      création) → revoke from public, anon PUIS grant explicite à
--      authenticated, pour ne rien casser :
--        - is_member_of : appelée directement dans les USING de 6 fichiers
--          de policies RLS (0001) — sans ce grant, TOUTE requête authenticated
--          sur les tables scopées merchant échouerait en permission denied.
--        - order_items_search_text : appelée depuis list_orders_paginated /
--          list_orders_keyset / get_order_view_counts / orders_view_counts,
--          toutes SECURITY INVOKER — le nested call s'exécute sous le rôle
--          appelant réel (authenticated), pas sous un DEFINER.
--        - derive_legacy_cod_status : appelée depuis orders_sync_legacy_cod_status
--          (SECURITY DEFINER, donc immunisée) — grant ajouté par cohérence/
--          prudence, sans risque de régression.
--        - validate_pcd_access_audit_metadata : appelée dans un CHECK
--          constraint / une fonction DEFINER d'audit PCD — grant ajouté par
--          la même prudence.
--        - sn_phone_e164 (ajout de ce lot) : appelée depuis
--          list_orders_paginated / list_orders_keyset / get_order_view_counts
--          / orders_view_counts, toutes SECURITY INVOKER — même raison que
--          order_items_search_text ci-dessus.
--
--   D. VIVANTE, déjà correctement restreinte à `service_role` SEUL
--      (`purge_pcd_access_audit`, 0123) — le `revoke ... from public` de
--      0123 ne touchait pas le mécanisme (2) donc anon gardait l'accès,
--      mais son grant `service_role` était déjà correct et n'est pas
--      touché. `revoke from public, anon` seulement — PAS de grant à
--      authenticated (la fonction elle-même refuse tout appelant qui n'est
--      pas `service_role`, `authenticated` ne doit jamais l'atteindre).
--
-- Vérifié en lisant le corps SQL réel de chaque fonction et son historique
-- complet de migrations (pas déduit), ET en comparant `pg_proc.proacl`
-- avant/après sur les 15 fonctions vivantes touchées par ce fichier — pas
-- seulement la présence d'une instruction `revoke` dans le SQL.
-- `resolve_order_required_component_quantities`, `receive_purchase_lot`,
-- `cash_aging`, `get_customer_reliability`, `ia_finance_cost_movements`,
-- `ia_product_cump`, `ia_count_recent_tool_calls`, `log_ia_tool_audit`,
-- `reassign_order_driver`, `purge_pcd_access_audit` gardent leur
-- SECURITY/volatilité/search_path inchangés — aucun DROP ni CREATE OR
-- REPLACE ici, seulement des REVOKE/GRANT, donc aucun reset d'ACL
-- supplémentaire à craindre pour la suite.
-- ============================================================

-- ── Groupe A : fonctions mortes — revoke total ────────────────────────────

revoke all on function public.list_orders_paginated(
  uuid,
  text,
  text,
  timestamptz,
  uuid,
  integer
) from public, anon, authenticated;

revoke all on function public.orders_view_counts(
  uuid,
  text
) from public, anon, authenticated;

revoke all on function public.list_customer_reliability(
  uuid,
  text,
  integer,
  integer,
  boolean
) from public, anon, authenticated;

-- ── Groupe B : vivantes, grant authenticated déjà posé — ferme public/anon ─

revoke all on function public.cash_aging(uuid) from public, anon;

revoke all on function public.receive_purchase_lot(
  uuid,
  uuid,
  uuid,
  jsonb
) from public, anon;

revoke all on function public.resolve_order_required_component_quantities(
  uuid
) from public, anon;

revoke all on function public.get_customer_reliability(
  uuid,
  uuid
) from public, anon;

revoke all on function public.ia_finance_cost_movements(
  uuid,
  uuid[]
) from public, anon;

revoke all on function public.ia_product_cump(
  uuid,
  uuid[]
) from public, anon;

revoke all on function public.ia_count_recent_tool_calls(
  uuid,
  timestamptz
) from public, anon;

revoke all on function public.log_ia_tool_audit(
  uuid,
  text,
  text,
  jsonb,
  boolean,
  uuid,
  text,
  integer,
  text
) from public, anon;

revoke all on function public.reassign_order_driver(
  uuid,
  uuid,
  uuid,
  text
) from public, anon;

-- ── Groupe D : vivante, déjà restreinte à service_role — ferme public/anon,
--    aucun grant authenticated (la fonction refuse tout non-service_role) ──

revoke all on function public.purge_pcd_access_audit(
  timestamptz,
  integer
) from public, anon;

-- ── Groupe C : vivantes, jamais grantées explicitement — ferme puis rouvre
--    à authenticated pour préserver le comportement actuel ─────────────────

revoke all on function public.is_member_of(uuid) from public, anon;
grant execute on function public.is_member_of(uuid) to authenticated;

revoke all on function public.order_items_search_text(jsonb) from public, anon;
grant execute on function public.order_items_search_text(jsonb) to authenticated;

revoke all on function public.derive_legacy_cod_status(
  text,
  text,
  text,
  text
) from public, anon;
grant execute on function public.derive_legacy_cod_status(
  text,
  text,
  text,
  text
) to authenticated;

revoke all on function public.validate_pcd_access_audit_metadata(jsonb) from public, anon;
grant execute on function public.validate_pcd_access_audit_metadata(jsonb) to authenticated;

revoke all on function public.sn_phone_e164(text) from public, anon;
grant execute on function public.sn_phone_e164(text) to authenticated;
