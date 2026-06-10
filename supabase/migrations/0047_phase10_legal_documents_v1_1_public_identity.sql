-- ============================================================
-- 0047 : Documents legaux v1.1 - identite publique teer.inc
-- ============================================================
-- Contexte :
--   * Les documents publics ne doivent plus exposer d'informations
--     personnelles nominatives ou d'adresse detaillee.
--   * Le contenu public canonique dans docs/legal/ a ete modifie :
--       - identite publique -> teer.inc
--       - adresse -> Dakar, Senegal
--       - retrait des emails / telephones / WhatsApp personnels
--   * Le consentement probant doit porter sur le contenu exact affiche :
--     nouvelle version 1.1 + nouveaux content_hash.
--
-- Hashes SHA-256 docs/legal/ v1.1 :
--   * conditions-generales.md            -> ee82418711da04f6946223852dddbbfbe0a169bb20ec370bf7a35d28b233695b
--   * politique-confidentialite.md       -> bfe11ad93b23516025cc08258a98eee97a93a0053b6e213eeca2a7a726b19b32
--   * mentions-legales.md                -> f0f49deb7137bd6c48cd1ddf7d28237df266d650d56fd376f3bd410d51b11619
--   * dpa-accord-sous-traitance.md       -> a97f032a190c2c89db6eb5a0aadfec14a71011531925a35cd2a6ec40172b526a
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
    '1.1',
    'ee82418711da04f6946223852dddbbfbe0a169bb20ec370bf7a35d28b233695b',
    '/conditions',
    true
  ),
  (
    'privacy',
    '1.1',
    'bfe11ad93b23516025cc08258a98eee97a93a0053b6e213eeca2a7a726b19b32',
    '/confidentialite',
    true
  ),
  (
    'mentions',
    '1.1',
    'f0f49deb7137bd6c48cd1ddf7d28237df266d650d56fd376f3bd410d51b11619',
    '/mentions-legales',
    true
  ),
  (
    'dpa',
    '1.1',
    'a97f032a190c2c89db6eb5a0aadfec14a71011531925a35cd2a6ec40172b526a',
    '/dpa',
    true
  );
