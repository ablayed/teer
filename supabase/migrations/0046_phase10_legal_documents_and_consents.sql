-- ============================================================
-- 0046 : Pages legales versionnees + consentements probants
-- ============================================================
-- Contexte :
--   * 4 documents legaux publics seront rendus statiquement cote app.
--   * Le consentement au signup doit etre prouvable et append-only.
--   * Cette migration cree les tables, RLS, et seed les versions 1.0.
--
-- Hashes SHA-256 des fichiers canoniques nettoyes dans docs/legal/ :
--   * conditions-generales.md            -> ee07e119a5cd7a409cf92286918b7e9d6e702fdbf9f58a2eaefb26e29d3d81e2
--   * politique-confidentialite.md       -> de9ce20dfac21865865e91e24008e7c1894e3dbc232fbf478d51748e664a781e
--   * mentions-legales.md                -> c5071d6b87c12afa755cbd631969a2c3a297a97d12dbae8a56dba5437e47e097
--   * dpa-accord-sous-traitance.md       -> 7b371e34fdcd9c8371e463903c72c261bf0cb8fa0192e31934ed589a903b2439
-- ============================================================

create table public.legal_documents (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('cgu', 'privacy', 'dpa', 'mentions')),
  version text not null,
  content_hash text not null,
  body_url text,
  published_at timestamptz not null default now(),
  is_current boolean not null default true,
  unique (type, version)
);

create table public.user_consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  document_type text not null check (document_type in ('cgu', 'privacy', 'dpa', 'mentions')),
  document_version text not null,
  content_hash text not null,
  accepted_at timestamptz not null default now(),
  ip_address inet,
  user_agent text,
  method text not null default 'signup_checkbox'
);

create index user_consents_user_id_idx on public.user_consents (user_id);

alter table public.legal_documents enable row level security;
alter table public.legal_documents force row level security;
alter table public.user_consents enable row level security;
alter table public.user_consents force row level security;

create policy legal_documents_select on public.legal_documents
  for select
  to authenticated
  using (true);

create policy user_consents_select on public.user_consents
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy user_consents_insert on public.user_consents
  for insert
  to authenticated
  with check (auth.uid() = user_id);

insert into public.legal_documents (
  type,
  version,
  content_hash,
  body_url
)
values
  (
    'cgu',
    '1.0',
    'ee07e119a5cd7a409cf92286918b7e9d6e702fdbf9f58a2eaefb26e29d3d81e2',
    '/conditions'
  ),
  (
    'privacy',
    '1.0',
    'de9ce20dfac21865865e91e24008e7c1894e3dbc232fbf478d51748e664a781e',
    '/confidentialite'
  ),
  (
    'mentions',
    '1.0',
    'c5071d6b87c12afa755cbd631969a2c3a297a97d12dbae8a56dba5437e47e097',
    '/mentions-legales'
  ),
  (
    'dpa',
    '1.0',
    '7b371e34fdcd9c8371e463903c72c261bf0cb8fa0192e31934ed589a903b2439',
    '/dpa'
  );
