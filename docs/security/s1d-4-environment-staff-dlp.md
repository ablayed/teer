# S1D-4 — séparation des environnements, comptes staff et prévention des fuites

Ce document couvre les contrôles locaux nécessaires au niveau 2 PCD. Il ne constitue pas une preuve de configuration Supabase, Vercel, Shopify, GitHub, Sentry, PostHog, Groq, Resend, Upstash ou du stockage de sauvegarde. Ces éléments sont repérés comme preuves manuelles à obtenir avant la soumission.

## Règles de séparation

| Environnement | Données autorisées | PCD réelles | Ressources et credentials | Nettoyage |
| --- | --- | --- | --- | --- |
| Local | fixtures synthétiques | Interdites | Supabase Docker ou services locaux ; credentials de test uniquement | supprimer fixtures et temporaires après test |
| Tests unitaires/RLS/E2E | fixtures synthétiques | Interdites | Supabase local/éphémère ; tokens de test contrôlés | `test-results`, traces et rapports ignorés par Git et supprimés après usage |
| Preview Vercel | synthétiques ou anonymisées | Interdites | variables Preview distinctes ; ressources dédiées à confirmer | supprimer les données de démonstration et vérifier la rétention fournisseur |
| Production Vercel | données réelles minimisées, finalités déclarées | Autorisées selon RLS et finalité | variables Production et projet Supabase de production | rétention applicative et fournisseur à vérifier |

Les règles suivantes sont obligatoires : aucun dump de production, webhook réel, token de production, capture ou sauvegarde de production ne devient une fixture, un snapshot, un ticket, un document ou un prompt IA. Un webhook réel ne peut être rejoué qu’après assainissement et remplacement des identifiants. Les previews ne sont pas considérées isolées tant que le projet Supabase, le Storage, les variables, l’observabilité et les accès humains n’ont pas été vérifiés.

Les fonctions `classifyDeploymentEnvironment`, `isPublicBrowserEnvironmentName` et `isServerOnlyEnvironmentName` fournissent le vocabulaire local déterministe. La validation de production existante refuse déjà les endpoints locaux/HTTP, les placeholders, les modes de test et les clés de chiffrement invalides.

## Frontière navigateur/serveur

Le navigateur ne reçoit que les variables `NEXT_PUBLIC_*` explicitement déclarées dans `PUBLIC_BROWSER_ENV_NAMES`. Le service role Supabase, les secrets Shopify, les clés de chiffrement, les credentials fournisseurs, les secrets de cron, la clé de sauvegarde et les credentials de base de données sont classés serveur uniquement. Les modules client sont contrôlés statiquement afin de ne pas importer `lib/env` ni lire ces noms.

Le client Supabase navigateur utilise uniquement l’URL publique et la clé anon. Les clients admin/service-role sont créés dans des modules serveur ou des routes serveur. La preuve locale est statique et le contrôle du bundle de production est exécuté par `pnpm security:s1d4:client-bundle`; une vérification du déploiement réel reste manuelle.

Fraunces est auto-hébergée via `@fontsource-variable/fraunces` (licence OFL-1.1), avec les variantes variable romaine et italique. Aucun téléchargement Google Fonts n’est requis pendant le build.

## Authentification humaine

Le contrôle local actuel impose un mot de passe d’au moins 10 caractères avec majuscule, minuscule, chiffre et caractère spécial lors de la création et du changement. Le changement de mot de passe et les opérations DSAR sensibles ré-authentifient l’utilisateur. Les connexions sont limitées par IP lorsque Upstash est configuré, avec des réponses génériques qui n’énumèrent pas les comptes. Le timeout d’inactivité et l’invalidation locale de session sont testés avec des valeurs synthétiques.

Ce contrôle ne remplace pas MFA/AAL2, les rôles de console, les règles de récupération de compte ou la révocation fournisseur. Aucun compte partagé ni aucun bypass privilégié n’est autorisé par la politique cible. Le support courant doit rester sans accès aux PCD ; tout accès exceptionnel doit suivre le runbook S1D-3, être justifié, limité dans le temps et journalisé sans PCD.

## Stratégie DLP MVP

### Entrées

- Valider les imports et uploads selon le contrat de la fonctionnalité et refuser les champs non nécessaires.
- Borner les tailles de fichiers et de champs ; ne pas accepter un payload webhook ou CSV comme texte libre destiné à la télémétrie.
- Ne jamais transférer un export, une sauvegarde ou une fixture contenant des PCD vers un outil de développement ou d’assistance.

### Sorties

- Les exports DSAR et documents imprimables sont générés sur un chemin serveur autorisé et soumis à la rétention existante ; ils ne sont pas des événements analytics.
- Les erreurs, traces et événements Sentry sont réduits à des métadonnées techniques. Les champs utilisateur, headers, cookies, corps, requêtes, exceptions et contextes arbitraires sont supprimés.
- PostHog conserve seulement des labels techniques bornés, chemins normalisés, booléens et nombres finis. Les chaînes sous des clés inconnues, les URL brutes, noms, coordonnées, adresses, tokens, payloads et textes libres sont supprimés.
- Les prompts IA, emails et messages WhatsApp ne doivent contenir que les données nécessaires à leur finalité ; cette règle reste contrôlée par les chemins métier et leurs tests, pas par un fournisseur distant.

### Développement et CI

`.gitignore` exclut les environnements, builds, couvertures, rapports Playwright, résultats et traces. Le workflow CI scanne l’historique avec Gitleaks, nettoie les fichiers d’environnement de test avant les artefacts et limite leur rétention déclarée. Le contrôle local vérifie qu’aucun dump, archive, rapport ou répertoire d’artefact sensible n’est suivi par Git. La présence effective d’un artefact CI distant et sa rétention sont à vérifier manuellement.

## Exercice local S1D-4

Une sentinelle synthétique est injectée dans un événement Sentry et un événement PostHog sous des clés arbitraires, dans un chemin, une URL, un breadcrumb, une exception, un tag, un cookie/header et un contexte utilisateur. Les sanitiseurs suppriment ces valeurs ou remplacent le segment dynamique par `:id`. Le test vérifie uniquement l’absence de la sentinelle et conserve une preuve de résultat non sensible. Le runbook S1D-3 est la procédure de confinement/révocation simulée ; aucune alerte ni révocation réelle n’est effectuée.

## Revue périodique

À chaque release et au minimum trimestriellement au lancement : vérifier les imports client, le bundle, les variables d’environnement, les chemins de logs, les artefacts CI, les intégrations IA/email/analytics, les fixtures et les répertoires temporaires. Après une fuite suspectée : geler les preuves sans les recopier, confiner, révoquer/faire tourner les credentials concernés, évaluer l’impact, puis appliquer le runbook S1D-3 et les obligations à vérifier auprès de Shopify, des fournisseurs et du conseil juridique.

## Checklist de preuves distantes

Pour chaque écran, relever uniquement des noms de projets, rôles, statuts, régions, dates de rétention et paramètres non sensibles. Masquer toute clé, token, URL de connexion, PCD, contenu de log ou contenu d’archive.

| Fournisseur / rubrique | Preuve attendue | Capture acceptable | Si absente |
| --- | --- | --- | --- |
| Supabase — Project Settings, Database, Storage, Auth, Members | projets/régions distincts, TLS/chiffrement, membres, rôles, MFA, accès Storage/DB | page de paramètres sans secrets ni données | séparation et accès production non prouvés |
| Vercel — Environments, Members, Logs, Deployments | variables Preview/Production distinctes, rôles, 2FA, domaine HTTPS, accès logs | noms d’environnements et statuts masqués | séparation et comptes staff non prouvés |
| Shopify Partner — Team/API credentials | collaborateurs, permissions, 2FA, boutique de développement, historique et révocation | rôles et statuts sans credentials | contrôle Shopify et révocation non prouvés |
| GitHub — Settings/Environments/Actions/Audit log | protections de branche, 2FA, secrets par environnement, artefacts/rétention | noms de règles et durées sans valeurs | chaîne CI et artefacts non prouvés |
| Sentry — Projects/Inbound Filters/Data Scrubbing/Retention/Members | filtrage, scrubbers, rétention et membres | réglages non sensibles | télémétrie production non prouvée |
| PostHog — Project Settings/Privacy/Data Retention/Members | capture, rétention, accès humains, région | réglages sans événements | analytics production non prouvées |
| Groq, Resend, Upstash — Members/Keys/Logs/Retention | rôles, MFA, rétention et révocation disponibles | rôles et statuts, jamais les clés | fournisseurs et accès non prouvés |
| Stockage des sauvegardes — Security/Versioning/Retention | chiffrement, région, accès, MFA, rétention et suppression | paramètres sans objet ni contenu | sauvegarde de production non prouvée |

Cette checklist ne demande jamais de copier un secret ou une PCD dans le dépôt ou dans le rapport.

## Limites et responsabilités

Les tests, les règles et le bundle local prouvent une capacité du dépôt. Ils ne prouvent pas que Preview et Production utilisent effectivement des projets distincts, que MFA est active, que les comptes sont individuels, que les fournisseurs filtrent leurs données, ni que leurs journaux et artefacts ont la rétention attendue. Ces éléments restent à vérifier manuellement par Ablaye. Les documents juridiques ne sont pas modifiés ici ; toute affirmation de leur contenu qui dépasse ces preuves techniques doit être validée séparément.
