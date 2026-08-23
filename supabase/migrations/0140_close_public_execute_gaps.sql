-- ============================================================
-- 0140 : ferme les EXECUTE ouverts à PUBLIC/anon — 3 fonctions mortes
-- + 8 fonctions vivantes jamais explicitement revoke depuis leur création
-- ============================================================
-- Contexte (audit Lot F, préalable Lot final Phase 1) : PostgreSQL accorde
-- EXECUTE à PUBLIC par défaut sur toute fonction nouvellement CREATE, et un
-- DROP FUNCTION + CREATE FUNCTION repart de zéro (les revoke/grant portant
-- sur l'ANCIENNE signature ne s'appliquent pas à la nouvelle — leçon 0067).
-- Balayage complet 0001→0139 : 9 fonctions non-trigger sont dans cet état
-- (jamais de `revoke ... from public`/`from anon` postérieur à leur dernier
-- CREATE frais), + list_orders_paginated/orders_view_counts déjà revoke
-- correctement de public/anon (0062) mais toujours accessibles à
-- `authenticated` alors qu'elles sont mortes.
--
-- Aucune fuite de données prouvée sur aucune des 9 (chacune protégée par une
-- couche différente : garde de rôle NULL-safe, RLS + grants table sur les
-- données sous-jacentes, ou fonction pure sans accès table) — c'est une
-- fermeture de surface d'attaque, pas un correctif d'incident.
--
-- Trois groupes :
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
--
-- Vérifié en lisant le corps SQL réel de chaque fonction et son historique
-- complet de migrations (pas déduit). `resolve_order_required_component_quantities`,
-- `receive_purchase_lot`, `cash_aging`, `get_customer_reliability` gardent leur
-- SECURITY/volatilité/search_path inchangés — aucun DROP ni CREATE OR REPLACE
-- ici, seulement des REVOKE/GRANT, donc aucun reset d'ACL supplémentaire à
-- craindre pour la suite.
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
