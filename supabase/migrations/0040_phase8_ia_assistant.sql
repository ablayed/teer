-- ════════════════════════════════════════════════════════════════════════
-- Phase 8 — Assistant IA (lecture seule) + FAQ
--
-- Crée le socle de persistance de l'assistant :
--   1. ia_conversation  — fils de discussion (par tenant + utilisateur)
--   2. ia_message       — messages user/assistant/tool d'une conversation
--   3. ia_tool_audit     — journal de CHAQUE appel d'outil (autorisé ou refusé)
--   4. ia_faq (optionnel) — Q&A statique role-aware
--
-- Décisions verrouillées (Stage 0) :
--   • PAS de Custom Access Token Auth Hook : le rôle reste dérivé via
--     public.current_member_role(merchant_account_id) (lookup DB + RLS).
--   • RLS deny-by-default. auth.uid() enveloppé dans (select …) pour la perf.
--   • ia_conversation/ia_message : FORCE RLS, scopés (tenant + user_id).
--   • ia_tool_audit : SELECT owner-only ; écriture UNIQUEMENT via la fonction
--     SECURITY DEFINER log_ia_tool_audit() afin de pouvoir journaliser même
--     les tentatives REFUSÉES (rôle insuffisant). Une fonction definer ne
--     contourne RLS que si la table est ENABLE et NON FORCE → cette table est
--     volontairement ENABLE-only (exception documentée vs les tables tenant).
-- ════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────
-- 1. ia_conversation
-- ────────────────────────────────────────────────────────────

create table public.ia_conversation (
  id                  uuid        primary key default gen_random_uuid(),
  merchant_account_id uuid        not null references public.merchant_account(id) on delete cascade,
  user_id             uuid        not null references auth.users(id) on delete cascade,
  title               text,
  summary             text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index ia_conversation_merchant_user_idx
  on public.ia_conversation (merchant_account_id, user_id, updated_at desc);

create trigger ia_conversation_set_updated_at
  before update on public.ia_conversation
  for each row
  execute function public.set_updated_at();

alter table public.ia_conversation enable row level security;
alter table public.ia_conversation force row level security;

-- Un utilisateur ne voit/écrit QUE ses propres conversations, dans son tenant.
create policy ia_conversation_select
  on public.ia_conversation
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    and public.current_member_role(merchant_account_id) is not null
  );

create policy ia_conversation_insert
  on public.ia_conversation
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and public.current_member_role(merchant_account_id) is not null
  );

create policy ia_conversation_update
  on public.ia_conversation
  for update
  to authenticated
  using (
    user_id = (select auth.uid())
    and public.current_member_role(merchant_account_id) is not null
  )
  with check (
    user_id = (select auth.uid())
    and public.current_member_role(merchant_account_id) is not null
  );

create policy ia_conversation_delete
  on public.ia_conversation
  for delete
  to authenticated
  using (
    user_id = (select auth.uid())
    and public.current_member_role(merchant_account_id) is not null
  );

-- ────────────────────────────────────────────────────────────
-- 2. ia_message
-- ────────────────────────────────────────────────────────────

create table public.ia_message (
  id                  uuid        primary key default gen_random_uuid(),
  conversation_id     uuid        not null references public.ia_conversation(id) on delete cascade,
  merchant_account_id uuid        not null references public.merchant_account(id) on delete cascade,
  role                text        not null,
  content             text        not null,
  created_at          timestamptz not null default now(),
  constraint ia_message_role_check check (role in ('user', 'assistant', 'tool'))
);

create index ia_message_conversation_idx
  on public.ia_message (conversation_id, created_at);

alter table public.ia_message enable row level security;
alter table public.ia_message force row level security;

-- Accès dérivé de la possession de la conversation parente
-- (lie implicitement tenant + user_id ; vérifie aussi la cohérence du tenant).
create policy ia_message_select
  on public.ia_message
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.ia_conversation c
      where c.id = conversation_id
        and c.user_id = (select auth.uid())
        and c.merchant_account_id = ia_message.merchant_account_id
    )
  );

create policy ia_message_insert
  on public.ia_message
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.ia_conversation c
      where c.id = conversation_id
        and c.user_id = (select auth.uid())
        and c.merchant_account_id = ia_message.merchant_account_id
    )
  );

-- ────────────────────────────────────────────────────────────
-- 3. ia_tool_audit
--
-- ENABLE-only (pas FORCE) : voir l'en-tête. SELECT owner-only ; aucune
-- politique INSERT/UPDATE/DELETE → seules les écritures via la fonction
-- SECURITY DEFINER passent (elle s'exécute comme propriétaire de la table).
-- ────────────────────────────────────────────────────────────

create table public.ia_tool_audit (
  id                  uuid        primary key default gen_random_uuid(),
  merchant_account_id uuid        not null references public.merchant_account(id) on delete cascade,
  user_id             uuid        not null references auth.users(id) on delete cascade,
  user_role           text        not null,
  conversation_id     uuid        references public.ia_conversation(id) on delete set null,
  tool_name           text        not null,
  tool_args           jsonb       not null default '{}'::jsonb,
  allowed             boolean     not null,
  denied_reason       text,
  latency_ms          integer,
  created_at          timestamptz not null default now()
);

create index ia_tool_audit_merchant_user_created_idx
  on public.ia_tool_audit (merchant_account_id, user_id, created_at desc);

create index ia_tool_audit_merchant_created_idx
  on public.ia_tool_audit (merchant_account_id, created_at desc);

alter table public.ia_tool_audit enable row level security;

-- Lecture réservée à l'owner (revue de sécurité). Aucune politique d'écriture :
-- l'insertion ne passe QUE par log_ia_tool_audit() (SECURITY DEFINER).
create policy ia_tool_audit_select
  on public.ia_tool_audit
  for select
  to authenticated
  using (public.current_member_role(merchant_account_id) = 'owner');

-- ────────────────────────────────────────────────────────────
-- 3b. log_ia_tool_audit — écriture journalisée (definer)
--
-- Journalise un appel d'outil, y compris les tentatives refusées. Garde
-- anti-usurpation : n'écrit que pour l'utilisateur courant, membre du tenant.
-- En cas d'incohérence on n'insère rien (pas d'exception : ne jamais casser le
-- flux de chat à cause du journal).
-- ────────────────────────────────────────────────────────────

create or replace function public.log_ia_tool_audit(
  p_merchant_account_id uuid,
  p_user_role           text,
  p_tool_name           text,
  p_tool_args           jsonb,
  p_allowed             boolean,
  p_conversation_id     uuid    default null,
  p_denied_reason       text    default null,
  p_latency_ms          integer default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  -- Anti-usurpation : appelant authentifié ET membre du tenant.
  if v_uid is null then
    return null;
  end if;
  if public.current_member_role(p_merchant_account_id) is null then
    return null;
  end if;

  insert into public.ia_tool_audit (
    merchant_account_id, user_id, user_role, conversation_id,
    tool_name, tool_args, allowed, denied_reason, latency_ms
  )
  values (
    p_merchant_account_id, v_uid, p_user_role, p_conversation_id,
    p_tool_name, coalesce(p_tool_args, '{}'::jsonb), p_allowed, p_denied_reason, p_latency_ms
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.log_ia_tool_audit(
  uuid, text, text, jsonb, boolean, uuid, text, integer
) from public;
grant execute on function public.log_ia_tool_audit(
  uuid, text, text, jsonb, boolean, uuid, text, integer
) to authenticated;

-- ────────────────────────────────────────────────────────────
-- 3c. ia_count_recent_tool_calls — compteur de rate-limit (definer)
--
-- Permet à CHAQUE utilisateur (y compris agent/manager qui ne peuvent pas
-- lire ia_tool_audit) de compter SES propres appels récents sans exposer la
-- table. Ne compte que les lignes de l'utilisateur courant.
-- ────────────────────────────────────────────────────────────

create or replace function public.ia_count_recent_tool_calls(
  p_merchant_account_id uuid,
  p_since               timestamptz
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_count integer;
begin
  if v_uid is null then
    return 0;
  end if;
  if public.current_member_role(p_merchant_account_id) is null then
    return 0;
  end if;

  select count(*)
  into v_count
  from public.ia_tool_audit a
  where a.merchant_account_id = p_merchant_account_id
    and a.user_id = v_uid
    and a.created_at >= p_since;

  return coalesce(v_count, 0);
end;
$$;

revoke all on function public.ia_count_recent_tool_calls(uuid, timestamptz) from public;
grant execute on function public.ia_count_recent_tool_calls(uuid, timestamptz) to authenticated;

-- ────────────────────────────────────────────────────────────
-- 4. ia_faq (optionnel) — Q&A statique, contenu global role-aware
--
-- Pas de tenant : aide produit partagée. min_role gouverne l'affichage
-- (filtrage applicatif couche A). Lecture pour tout authentifié ; écriture
-- réservée (aucune politique INSERT/UPDATE/DELETE → géré par migration/seed).
-- ────────────────────────────────────────────────────────────

create table public.ia_faq (
  id          uuid        primary key default gen_random_uuid(),
  question_fr text        not null,
  answer_fr   text        not null,
  min_role    text        not null default 'agent',
  sort_order  integer     not null default 0,
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now(),
  constraint ia_faq_min_role_check check (min_role in ('owner', 'manager', 'agent')),
  constraint ia_faq_question_not_blank check (btrim(question_fr) <> ''),
  constraint ia_faq_answer_not_blank   check (btrim(answer_fr) <> '')
);

create index ia_faq_active_sort_idx
  on public.ia_faq (is_active, sort_order);

alter table public.ia_faq enable row level security;
alter table public.ia_faq force row level security;

create policy ia_faq_select
  on public.ia_faq
  for select
  to authenticated
  using (true);
