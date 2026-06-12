-- 0051_mm_insert_owner_only.sql
-- Durcissement RLS : merchant_member INSERT.
--
-- Contexte : l'ancienne policy mm_insert autorisait
--   with check ( is_member_of(merchant_account_id) or user_id = auth.uid() )
-- Deux trous :
--   1. is_member_of(...) : n'importe quel membre (agent/manager) pouvait INSERT
--      un membre avec role='owner' -> escalation de privilège intra-tenant.
--   2. user_id = auth.uid() (non contraint) : tout user authentifié pouvait
--      s'auto-insérer (n'importe quel role) dans le tenant d'un autre
--      -> escalation cross-tenant.
--
-- Aucun chemin légitime ne fait d'INSERT direct via le client authentifié :
--   - signup           -> trigger handle_new_user (SECURITY DEFINER, bypass RLS)
--   - accept_invitation -> RPC SECURITY DEFINER (bypass RLS confirmé : rolbypassrls=true)
--   - owner ajoute      -> passe par invitation, jamais d'INSERT direct
-- Donc on restreint l'INSERT direct au seul owner du tenant concerné.
-- current_member_role(merchant_account_id) est évalué pour le tenant de la
-- ligne insérée -> un owner du tenant A ne peut pas insérer dans le tenant B.

alter policy mm_insert on public.merchant_member
  with check (public.current_member_role(merchant_account_id) = 'owner');
