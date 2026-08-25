-- ============================================================================
-- 0143 — Lot L3 (réduit) : matériaux du jeton d'URL opaque par installation
-- ============================================================================
-- Purement additif. Une seule table nouvelle, aucune colonne touchée ailleurs.
-- Ne câble aucune bascule d'abonnement Shopify (hors périmètre du lot réduit,
-- cf. rapport de session) — cette migration ne fait qu'exister au repos tant
-- qu'aucun code applicatif ne l'exploite.
--
-- Pourquoi une table séparée, jamais une colonne sur store_connection : la
-- policy select existante de store_connection (0142) expose toute la ligne à
-- tout membre authentifié de la boutique — légitime pour l'identité de
-- connexion, jamais pour un secret. Cette table porte donc les matériaux du
-- jeton et RIEN d'autre, sans aucune policy authenticated (FORCE RLS + zéro
-- policy = zéro accès, quel que soit le grant ; le grant est de toute façon
-- retiré explicitement — leçon 0140/0141 : les grants sont évalués AVANT les
-- policies, jamais l'inverse).
--
-- Modèle courant + précédent (jamais public_id + secret par ligne de
-- rotation) : une SEULE ligne par store_connection, l'URL (dérivée de
-- public_id) reste donc stable à travers une rotation — seul secret_hash
-- change, l'ancien restant accepté jusqu'à previous_secret_expires_at. Même
-- motif que SHOPIFY_TOKEN_ENCRYPTION_KEY / _PREVIOUS (lib/shopify/crypto.ts).
-- ============================================================================

create table public.store_connection_webhook_token (
  id uuid primary key default gen_random_uuid(),
  store_connection_id uuid not null
    references public.store_connection (id) on delete cascade,
  public_id text not null,
  secret_hash text not null,
  previous_secret_hash text,
  previous_secret_expires_at timestamptz,
  rotated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  -- Une ligne par connexion : la génération (script, hors migration — un
  -- secret en clair ne doit jamais transiter par une transaction SQL sans
  -- moyen de le restituer à l'opérateur) crée cette ligne une fois: toute
  -- rotation suivante la MET À JOUR, jamais n'en insère une seconde.
  constraint store_connection_webhook_token_connection_key
    unique (store_connection_id),
  -- Clé de recherche de l'URL. Non secrète en soi (rôle de key id, pas de
  -- credential) — la confidentialité tient entièrement à secret_hash.
  constraint store_connection_webhook_token_public_id_key
    unique (public_id),
  -- Les deux colonnes de l'ancien secret vont toujours ensemble : soit aucune
  -- rotation n'a eu lieu (les deux nulles), soit une fenêtre de grâce bornée
  -- existe (les deux renseignées). Jamais l'un sans l'autre.
  constraint store_connection_webhook_token_previous_pair_check
    check ((previous_secret_hash is null) = (previous_secret_expires_at is null)),
  -- Plafond dur de 30 jours sur la fenêtre de grâce : empêche structurellement
  -- qu'une erreur applicative laisse l'ancien secret valide indéfiniment.
  -- « Jamais deux secrets valides indéfiniment » n'est donc pas qu'une
  -- convention de code, c'est une contrainte de base.
  constraint store_connection_webhook_token_grace_window_check
    check (
      previous_secret_expires_at is null
      or rotated_at is null
      or previous_secret_expires_at <= rotated_at + interval '30 days'
    )
);

alter table public.store_connection_webhook_token enable row level security;
alter table public.store_connection_webhook_token force row level security;

-- Aucune policy, pour aucun rôle authenticated. FORCE RLS + zéro policy =
-- refus total, y compris pour le propriétaire de la ligne — seul service_role
-- (bypass RLS par construction Postgres) peut lire ou écrire cette table.
-- Preuve n°5 du lot (surface non lisible) : tests/rls/l3-webhook-token-secrecy.rls.test.ts.
revoke all on table public.store_connection_webhook_token from public, anon, authenticated;
grant all on table public.store_connection_webhook_token to service_role;

create index store_connection_webhook_token_connection_idx
  on public.store_connection_webhook_token (store_connection_id);
