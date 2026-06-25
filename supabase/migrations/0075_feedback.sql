-- ════════════════════════════════════════════════════════════════════════
-- 0075 — Table feedback (signalement de bug / suggestion / question)
--
-- Décisions :
--   • FORCE RLS (cohérence avec les autres tables tenant).
--   • INSERT : tout membre authentifié du tenant via is_member_of().
--   • SELECT : propriétaire du tenant seulement via current_member_role().
--   • Écriture best-effort depuis l'action serveur (INSERT garanti,
--     email Resend try/catch — ne fait pas échouer l'action si absent).
--   • Colonnes non essentielles nullable (conformité règle RLS discipline).
-- ════════════════════════════════════════════════════════════════════════

create table public.feedback (
  id                  uuid        primary key default gen_random_uuid(),
  merchant_account_id uuid        not null references public.merchant_account(id) on delete cascade,
  actor_user_id       uuid        references auth.users(id) on delete set null,
  category            text        not null
                                    check (category in ('bug', 'suggestion', 'question', 'autre')),
  message             text        not null,
  page_context        text,
  user_agent          text,
  created_at          timestamptz not null default now()
);

create index feedback_merchant_created_idx
  on public.feedback (merchant_account_id, created_at desc);

alter table public.feedback enable row level security;
alter table public.feedback force row level security;

-- Tout membre authentifié du tenant peut soumettre un feedback.
create policy feedback_insert
  on public.feedback
  for insert
  to authenticated
  with check (public.is_member_of(merchant_account_id));

-- Seul le propriétaire du tenant peut lire les feedbacks.
create policy feedback_select
  on public.feedback
  for select
  to authenticated
  using (public.current_member_role(merchant_account_id) = 'owner');
