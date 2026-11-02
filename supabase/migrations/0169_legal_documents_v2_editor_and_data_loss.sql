-- ============================================================
-- 0169 : Documents legaux v2.0 - editeur et perte maximale de donnees
-- ============================================================
-- Les quatre fichiers canoniques sont dans docs/legal/.
-- Le hash est le SHA-256 des octets exacts de chaque fichier.
--
-- Hashes SHA-256 docs/legal/ v2.0 :
--   * conditions-generales.md            -> 94a85119b0ef3dc4018fa19d32e792fab7c01323121536b820735e8524da4e63
--   * politique-confidentialite.md       -> 2525e368abd5921296c38d245aa83cc65e16f9d047192a8da8b9121c11bbfe07
--   * mentions-legales.md                -> 8ea709198ae96bf99574c6f6aa63ea5c0960614e0ff74d66fc812407132f1426
--   * dpa-accord-sous-traitance.md       -> 5fede152158261275f4de7a3aa7e02405b3cf171a402b8c72ece7c530b3b4901
-- ============================================================

update public.legal_documents
set is_current = false
where type in ('cgu', 'privacy', 'mentions', 'dpa')
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
    'cgu',
    '2.0',
    '94a85119b0ef3dc4018fa19d32e792fab7c01323121536b820735e8524da4e63',
    '/conditions',
    true
  ),
  (
    'privacy',
    '2.0',
    '2525e368abd5921296c38d245aa83cc65e16f9d047192a8da8b9121c11bbfe07',
    '/confidentialite',
    true
  ),
  (
    'mentions',
    '2.0',
    '8ea709198ae96bf99574c6f6aa63ea5c0960614e0ff74d66fc812407132f1426',
    '/mentions-legales',
    true
  ),
  (
    'dpa',
    '2.0',
    '5fede152158261275f4de7a3aa7e02405b3cf171a402b8c72ece7c530b3b4901',
    '/dpa',
    true
  );
