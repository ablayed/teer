-- ============================================================
-- Spécification du rôle `ci_schema_auditor` — Phase 2 / Lot 4A, Couche 4
-- ============================================================
-- NON APPLIQUÉ. Ce fichier vit hors de supabase/migrations/ précisément pour ne
-- JAMAIS être rejoué automatiquement par `supabase db reset`/`db push`. La création
-- de ce rôle part avec le Lot 4B, sur décision explicite du porteur — raison : si
-- `CREATE ROLE` échoue sur la plateforme hébergée (permissions, plan, contrainte
-- Supabase non anticipée ici), cela ne doit pas bloquer le correctif préventif dont
-- dépend le reste de la Phase 2 (couches 1-3 de ce lot, déjà livrées).
--
-- OBJET : une sonde PRODUCTION récurrente (pas une formalité de clôture ponctuelle),
-- qui interroge l'ACL réelle (`pg_proc.proacl`, `has_function_privilege`,
-- `has_table_privilege`) directement sur la base de production — la seule façon de
-- détecter une dérive appliquée hors migration, à la manière de l'incident `0141`
-- (GRANT manuel jamais committé, invisible à tout rejeu local `db reset --local`).
--
-- Aucun mot de passe n'est fixé ici, ni dans aucune migration. Le mot de passe est
-- généré au moment de la création réelle (Lot 4B) et stocké UNIQUEMENT dans le
-- secret CI (`CI_SCHEMA_AUDITOR_DB_URL` ou équivalent) — jamais dans le dépôt.
-- ============================================================

-- --------------------------------------------------------------
-- 1. Création du rôle — LOGIN, sans aucun privilège élevé.
-- --------------------------------------------------------------
-- LOGIN : nécessaire pour une connexion directe (psql/pg client) depuis la CI.
-- Pas de mot de passe fixé ici — `ALTER ROLE ... PASSWORD '...'` s'exécute au moment
-- de la création réelle, avec un secret généré, jamais committé.
create role ci_schema_auditor with login;

-- Interdictions explicites, chacune motivée :
--   NOSUPERUSER   : contournerait purement et simplement RLS et tout le reste — une
--                   sonde d'audit n'a besoin d'aucun bypass, seulement de lecture
--                   catalogue.
--   NOCREATEROLE  : un rôle d'audit qui peut créer des rôles peut s'accorder des
--                   privilèges à lui-même a posteriori — inacceptable pour un rôle
--                   dont le seul but est de lire.
--   NOCREATEDB    : aucun besoin de créer des bases ; un rôle d'audit ne doit jamais
--                   pouvoir provisionner de nouvelle surface.
--   NOBYPASSRLS   : la sonde lit des CATALOGUES SYSTÈME (pg_proc, pg_default_acl,
--                   pg_class, pg_policies, information_schema), qui ne sont pas
--                   soumis à RLS de toute façon — BYPASSRLS ne lui donnerait rien de
--                   plus tout en élargissant sa surface de risque si le rôle était un
--                   jour compromis ou mal utilisé pour lire des tables applicatives.
alter role ci_schema_auditor with nosuperuser nocreatedb nocreaterole nobypassrls;

-- --------------------------------------------------------------
-- 2. Isolation d'appartenance — non membre des rôles applicatifs.
-- --------------------------------------------------------------
-- `ci_schema_auditor` ne doit JAMAIS hériter des privilèges de `postgres`,
-- `service_role`, `authenticated` ou `anon`. Aucune instruction `grant <role> to
-- ci_schema_auditor` n'existe dans ce fichier, et c'est intentionnel — l'absence EST
-- la garantie. Documenté ici pour qu'une future migration ne l'ajoute pas par erreur
-- en croyant "faciliter" l'audit.

-- --------------------------------------------------------------
-- 3. Propriété — aucun objet.
-- --------------------------------------------------------------
-- Le rôle ne CREATE jamais rien après sa création (NOCREATEDB/NOCREATEROLE ci-dessus,
-- et aucun `grant create` sur aucun schéma n'est accordé dans ce fichier). Il ne peut
-- donc jamais devenir propriétaire d'un objet applicatif.

-- --------------------------------------------------------------
-- 4. Aucun privilège d'écriture, sur aucun objet.
-- --------------------------------------------------------------
-- Aucune instruction `grant insert/update/delete` n'existe dans ce fichier. Seuls des
-- `grant select`/`grant usage` explicites suivent, sur des catalogues nommés.

-- --------------------------------------------------------------
-- 5. SELECT sur les seuls catalogues nécessaires à la baseline — énumérés.
-- --------------------------------------------------------------
-- Ces catalogues sont TOUS des vues/tables système, lisibles par n'importe quel rôle
-- via `information_schema`/`pg_catalog` par défaut sur PostgreSQL standard — mais
-- Supabase verrouille `pg_catalog`/`information_schema` à `anon`/`authenticated`
-- selon son propre modèle RLS ; ce rôle est un rôle SQL nu, hors RLS applicative, donc
-- ces `grant` sont explicites plutôt que supposés hérités.
grant usage on schema pg_catalog to ci_schema_auditor;
grant usage on schema information_schema to ci_schema_auditor;
grant usage on schema public to ci_schema_auditor;
grant usage on schema private to ci_schema_auditor;

grant select on pg_catalog.pg_proc to ci_schema_auditor;
grant select on pg_catalog.pg_namespace to ci_schema_auditor;
grant select on pg_catalog.pg_roles to ci_schema_auditor;
grant select on pg_catalog.pg_default_acl to ci_schema_auditor;
grant select on pg_catalog.pg_class to ci_schema_auditor;
grant select on pg_catalog.pg_policies to ci_schema_auditor;
grant select on pg_catalog.pg_type to ci_schema_auditor;
grant select on pg_catalog.pg_auth_members to ci_schema_auditor;
grant select on pg_catalog.pg_event_trigger to ci_schema_auditor;

-- --------------------------------------------------------------
-- 6. Capacité d'appeler has_function_privilege / has_table_privilege.
-- --------------------------------------------------------------
-- Ces deux fonctions sont STABLE, sans garde de rôle applicative (fonctions système
-- PostgreSQL de base, jamais redéfinies par ce projet) — exécutables par tout rôle
-- connecté par défaut. Aucun grant supplémentaire n'est nécessaire ; documenté ici
-- pour que la vérification "peut-il vraiment les appeler" figure dans la spec, et
-- soit re-testée au moment de la création réelle (Lot 4B) plutôt que supposée.

-- ============================================================
-- Utilisation prévue depuis la CI (Lot 4B, non appliqué ici)
-- ============================================================
-- - Variable d'environnement : `CI_SCHEMA_AUDITOR_DB_URL` (chaîne de connexion
--   complète incluant le mot de passe), stockée en secret GitHub Actions — jamais
--   dans un fichier committé, jamais dans les logs (le job doit rediriger toute
--   sortie contenant la chaîne de connexion vers le même mécanisme de
--   sanitisation que l'étape "Start Supabase (sanitized diagnostics)" existante
--   de `.github/workflows/ci.yml`).
-- - Secret absent : le job DOIT échouer explicitement (`exit 1` avec un message
--   nommant la variable manquante), jamais sauter silencieusement le contrôle. Le
--   script qui utilisera ce rôle (Lot 4B) doit vérifier la présence de la variable
--   AVANT toute tentative de connexion et refuser de démarrer sinon — même
--   discipline que `scripts/generate-acl-baseline.mjs --check` déjà livré dans ce
--   lot (fichier baseline absent → échec explicite, jamais un succès vide).
-- - Fréquence recommandée : QUOTIDIENNE, pas à chaque push. Raison : cette sonde
--   interroge la PRODUCTION réelle, contrairement aux couches 1-3 de ce lot qui
--   tournent sur un stack local jetable à chaque CI. Une fréquence par-push
--   multiplierait les connexions à la base de production pour un gain de détection
--   marginal (une dérive hors-migration ne se produit pas à chaque commit) ; une
--   fréquence quotidienne borne le délai de détection à 24h tout en gardant le
--   risque opérationnel (charge sur la base de prod, surface d'exposition d'un
--   secret supplémentaire) proportionné. À ajuster si un futur incident démontre
--   qu'un délai de 24h est trop long.
-- ============================================================
