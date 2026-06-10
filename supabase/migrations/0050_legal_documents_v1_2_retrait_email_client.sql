-- ============================================================
-- 0050 : Documents legaux v1.2 - retrait de l'email du client final
-- ============================================================
-- Contexte :
--   * Decision produit : Tëër ne demande plus / ne traite plus l'adresse
--     electronique du CLIENT FINAL (cf. migration 0049, retrait colonne).
--   * Deux documents publics listaient cet email dans les donnees des
--     Clients finaux : ils sont corriges dans docs/legal/ :
--       - politique-confidentialite.md (art. 4.b et 5)
--       - dpa-accord-sous-traitance.md (art. 2)
--   * L'email du MARCHAND reste mentionne (donnee du compte) : inchange.
--   * Le consentement probant porte sur le contenu exact affiche :
--     nouvelle version 1.2 + nouveaux content_hash → le Stage 4 re-prompte
--     les utilisateurs existants (getMissingCurrentConsents compare le
--     fingerprint type:version:hash).
--
-- NB : la version courante etait deja 1.1 (migration 0047), pas 1.0 →
--      on passe donc en 1.2. Seuls 'privacy' et 'dpa' changent ;
--      'cgu' et 'mentions' restent en 1.1 (contenu inchange).
--
-- Hashes SHA-256 docs/legal/ v1.2 (fichiers canoniques modifies) :
--   * politique-confidentialite.md  -> ec5cdd4b7e182aef24d81ef0c21374196e4ecbc4230c2a5e62439a643cd80f63
--   * dpa-accord-sous-traitance.md  -> 502f15730965a7094f03cd25e129e5ef6ae7480418138e91bde3945cd2ae201d
-- ============================================================

update public.legal_documents
set is_current = false
where type in ('privacy', 'dpa')
  and is_current = true;

insert into public.legal_documents (
  type,
  version,
  content_hash,
  body_url,
  is_current
)
values
  (
    'privacy',
    '1.2',
    'ec5cdd4b7e182aef24d81ef0c21374196e4ecbc4230c2a5e62439a643cd80f63',
    '/confidentialite',
    true
  ),
  (
    'dpa',
    '1.2',
    '502f15730965a7094f03cd25e129e5ef6ae7480418138e91bde3945cd2ae201d',
    '/dpa',
    true
  );
