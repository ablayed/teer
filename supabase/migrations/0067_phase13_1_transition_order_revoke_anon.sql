-- ============================================================
-- 0067 : phase13.1 — verrouille transition_order à `authenticated` (retire PUBLIC/anon)
-- ============================================================
-- Contexte : 0066 a recréé transition_order via DROP + CREATE. Une nouvelle fonction
-- Postgres reçoit `EXECUTE` à PUBLIC par DÉFAUT, et 0066 ne faisait que `grant ... to
-- authenticated` (additif) → PUBLIC/anon conservaient EXECUTE.
--
-- Note historique : ce n'est PAS une régression de 0066. transition_order n'a jamais eu
-- de revoke (créée en 0008 sans grant/revoke → PUBLIC par défaut ; 0016/0054/0056/0059
-- faisaient `create or replace` qui PRÉSERVE les grants existants, sans jamais retirer
-- PUBLIC). L'exposition était mitigée par `security invoker` + RLS FORCE : un appelant
-- anon n'a aucune ligne `orders` visible → `select ... for update` vide → `order_not_found`,
-- aucune mutation. 0066 (DROP) a simplement re-défauté à PUBLIC.
--
-- Fix-forward (0066 déjà appliquée → immuable) : moindre privilège, on retire EXECUTE à
-- public/anon et on le (re)donne explicitement à `authenticated` uniquement. Idempotent :
-- s'applique proprement en prod (par-dessus 0066) ET en CI/fresh (après 0066).
-- ============================================================

revoke all on function public.transition_order(
  uuid, uuid, text, text, text, text, text, text,
  integer, timestamptz, timestamptz, text, uuid,
  text[], boolean, boolean, boolean
) from public, anon;

grant execute on function public.transition_order(
  uuid, uuid, text, text, text, text, text, text,
  integer, timestamptz, timestamptz, text, uuid,
  text[], boolean, boolean, boolean
) to authenticated;
