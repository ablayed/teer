# S1D-2 — sauvegarde chiffrée et restauration contrôlée

Statut du lot : implémentation locale et preuve de reprise synthétique. La configuration de production, le plan Supabase réellement utilisé et tout stockage hors site restent à vérifier manuellement.

## Décisions et limites de preuve

La preuve Phase 0E annoncée dans le dossier projet n’a pas été retrouvée comme rapport ou artefact. `docs/phase-0b-foundation.md` conserve seulement une action « sauvegarde/restauration — à confirmer ». Elle ne prouve donc ni une sauvegarde de production ni une restauration.

La CLI Supabase installée est la version 2.102.0. Son aide expose `supabase db dump --local`, mais la documentation CLI précise que le dump par défaut exclut les schémas gérés `auth`, `storage` et ceux des extensions ; les rôles et les données doivent être demandés explicitement. La preuve S1D-2 utilise donc `pg_dump` 17.6 dans le conteneur PostgreSQL local, avec sélection explicite des schémas `public`, `auth`, `storage` et `supabase_migrations`, puis un composant ACL non sensible séparé. Cette implémentation ne doit jamais être interprétée comme un dump de production.

Références officielles : [Database Backups](https://supabase.com/docs/guides/platform/backups), [CLI `supabase db dump`](https://supabase.com/docs/reference/cli/supabase-projects-create), [Download Objects](https://supabase.com/docs/guides/storage/management/download-objects).

## Périmètre de reprise

| Composant | Criticité / PCD | Source de vérité | Archive S1D-2 | Méthode de restauration et test | Preuve locale | Preuve production manquante |
|---|---|---|---|---|---|---|
| Schéma PostgreSQL, extensions sélectionnées, migrations | critique ; indirectement PCD | migrations et PostgreSQL | oui, dump SQL chiffré | restauration dans une base locale neuve ; objets, fonctions, triggers et historique comparés | cycle local réussi | projet, version PostgreSQL et dump exploitable à confirmer |
| Données métier `customer`, `orders`, `delivery_address`, `webhook_event`, `audit_log` | critique ; PCD | Supabase DB | oui | invariants synthétiques, intégrité et audit append-only | 2 tenants synthétiques restaurés | export de production et dernière date de sauvegarde non prouvés |
| `merchant_account`, `merchant_member`, `shop` | critique ; accès et tokens chiffrés | Supabase DB | oui | relations et token Shopify synthétique vérifiés | oui | rôles et ACL de production à confirmer |
| Auth nécessaire (`auth.users` et relations utilisées) | critique | Supabase Auth/PostgreSQL | oui quand inclus explicitement | deux utilisateurs synthétiques et relations métier restaurés | oui | stratégie de restauration Auth du projet réel à confirmer |
| Métadonnées Storage (`storage.buckets`, `storage.objects`) | critique pour DSAR | Supabase Storage DB | oui | bucket et métadonnée d’objet synthétiques comparés | oui | buckets réels, rétention et droits à confirmer |
| Octets Storage | critique si l’objet est nécessaire | Storage API / objet exporté | oui, composant binaire séparé | hash et contenu synthétiques comparés après extraction | oui ; ne remplace pas un test fournisseur | export/restauration de chaque bucket de production à prouver |
| Artefacts DSAR | critique ; PCD possible | DB + Storage `shopify-dsar` | inclus selon statut/rétention, jamais au-delà de leur expiration | vérifier statut, expiration et objet associé ; purge avant export à confirmer | mécanisme local de purge documenté, pas d’artefact réel | inventaire, expiration et export réel non prouvés |
| Tokens Shopify | critique ; secret applicatif, pas une PCD en clair | `shop.access_token_encrypted` / crypto applicative | oui sous forme déjà chiffrée dans le dump, puis archive chiffrée | déchiffrement d’un token synthétique avec clé synthétique séparée | oui | rotation de clé et lisibilité de la production à confirmer |
| Configurations applicatives reproductibles | nécessaire à la reprise | dépôt, migrations, configuration versionnée | oui sous forme de code/migrations ; jamais de valeurs secrètes | migrations et scripts disponibles ; aucun secret dans l’archive | oui | variables réellement attribuées à Production à confirmer |
| Secrets, clés DB et clés fournisseurs | critique mais exclus des données | gestionnaire de secrets / opérateur | non | restauration séparée par procédure, sans valeur dans l’archive | séparation documentée | emplacement, copie de secours, accès et rotation manuels |
| Logs et observabilité | important pour qualification | Sentry, PostHog, logs fournisseur | non par défaut | rechercher les preuves via les fournisseurs, sans les copier dans l’archive | absence de logs distants testée non prouvée | rétention et export à confirmer |
| Données exclusivement détenues par les fournisseurs | dépendance externe | Shopify, Supabase, Vercel, Sentry, PostHog, etc. | non | procédure manuelle fournisseur | aucune | disponibilité, région, rétention et restauration à prouver |

Les noms de composants sont génériques (`db.sql`, `storage-object-0001.bin`, etc.). Aucun marchand, boutique, client, chemin réel ou identifiant PCD ne doit être utilisé dans un nom d’archive.

## Format et chiffrement

Les scripts `scripts/s1d2-backup-format.mjs` et `scripts/s1d2-restore.mjs` utilisent AES-256-GCM via les primitives Node.js standard :

- clé de 32 octets fournie uniquement par la variable opérateur `S1D2_BACKUP_KEY`, au format hexadécimal de 64 caractères ; jamais en argument de commande ;
- nonce aléatoire de 12 octets par archive ; tag d’authentification de 16 octets ;
- format versionné, algorithme et identifiant non sensible de clé dans l’en-tête ; manifest interne chiffré ;
- SHA-256 du ciphertext dans l’en-tête pour le contrôle de transport, puis vérification GCM pour l’authenticité ;
- écriture dans un fichier `.partial` puis renommage atomique ; suppression du fichier partiel en cas d’erreur ;
- erreur générique sur clé absente, mauvais format, mauvaise clé, archive altérée, archive tronquée ou version inconnue ;
- manifest et composants validés contre le parcours de chemin ; aucun composant ne peut sortir du répertoire d’extraction ;
- refus d’écrire une archive sous le répertoire de travail courant ; le cycle local écrit dans le répertoire temporaire système ;
- `SHOPIFY_TOKEN_ENCRYPTION_KEY` n’est jamais réutilisée : la clé de sauvegarde est une responsabilité opérateur indépendante.

Le dump SQL temporaire et les composants en clair sont supprimés avant la fin du cycle. Les tests vérifient qu’une sentinelle synthétique n’est pas visible dans l’archive ni dans les erreurs de format. Aucune archive n’est conservée dans le dépôt.

## Procédure locale reproductible

`pnpm test:s1d2:local-cycle` :

1. vérifie le conteneur local `supabase_db_teer-dev` ;
2. crée deux bases temporaires dont le nom est strictement `s1d2_source_*` / `s1d2_target_*` ;
3. charge le schéma choisi depuis PostgreSQL local, puis deux tenants, utilisateurs, commandes, adresses, événement webhook, audit, bucket, métadonnée Storage et token Shopify synthétiques ;
4. produit un dump SQL et un composant binaire Storage distinct ;
5. chiffre l’archive avec une clé synthétique interne au test, sans toucher à une variable d’exécution ;
6. vérifie le ciphertext, l’absence des sentinelles en clair et supprime le dump ;
7. restaure dans la base cible neuve en activant temporairement le mode de restauration PostgreSQL nécessaire aux triggers d’initialisation Auth, puis le rétablit avant les contrôles ;
8. contrôle comptes, relations, fonctions, triggers, historique de migrations, RLS forcée, politiques, ACL append-only, absence d’accès cross-tenant, objet Storage et déchiffrement du token synthétique ;
9. supprime l’extraction, l’archive, les dumps et les deux bases temporaires.

Cette désactivation temporaire des triggers concerne seulement le chargement contrôlé de fixtures et le replay du dump local ; elle ne constitue pas une procédure de production. En production, le mécanisme de restauration Supabase et les hooks Auth/Storage devront être testés selon le projet réel.

## Clés, rétention et reprise

La clé de sauvegarde n’est ni la clé Shopify, ni un credential de base de données, ni une variable Vercel. Elle doit être conservée dans un contexte opérateur dédié, avec une copie de secours séparée des archives, accès nominatif, MFA et journal de remise. Elle n’est jamais versionnée, loguée, envoyée dans un ticket ou ajoutée aux variables applicatives ordinaires.

Pour le lancement à budget nul, proposition à valider :

| Objectif | Cible proposée | Capacité démontrée |
|---|---|---|
| RPO | 24 h avec export logique quotidien après changement significatif | seulement le cycle local ; aucune fréquence Production prouvée |
| RTO | 8 h ouvrées pour une reprise manuelle faible volume | cycle local DB + contrôle en ~4,0 s ; ce temps exclut fournisseur, téléchargement, clé et validation métier |
| Rétention | 7 versions chiffrées, au plus 30 jours, puis destruction contrôlée | aucune archive de production existante prouvée |
| Sauvegarde pré-opération | avant migration, rotation ou opération destructive | procédure documentée, pas exécutée à distance |
| Copie hors site | indispensable avant soumission ; fournisseur gratuit à sélectionner et vérifier | non prouvée, donc pas de conformité production |

Une demande d’effacement ne modifie pas une archive historique de manière improvisée. La durée courte et documentée, la restriction d’accès, la destruction à échéance et un contrôle post-restauration empêchant la réintroduction des données effacées sont nécessaires. Une reprise doit rejouer les redactions ou appliquer une liste d’exclusion issue de la base active avant réouverture du service.

Si le projet Supabase est suspendu ou perdu : récupérer séparément la clé opérateur, l’archive la plus récente et les fichiers Storage ; créer une cible dédiée ; restaurer le schéma et les données ; recréer/valider les secrets ; restaurer les objets ; exécuter RLS, redaction, token et contrôles fonctionnels ; seulement ensuite envisager une remise en service. Cette procédure n’a pas été exécutée contre Production.

## Checklist manuelle de preuves de production

Ne relever que des métadonnées non sensibles. Masquer les URLs de connexion, tokens, clés, emails, noms de boutiques, PCD, chemins d’objet et contenu d’archive. Une capture acceptable montre l’écran et l’état général sans valeur secrète.

### Supabase Dashboard

| Écran/rubrique | À relever | Capture acceptable | Attendu | Conséquence si absent |
|---|---|---|---|---|
| Project Settings / General | projet réellement utilisé, région, version PostgreSQL, plan | nom de projet tronqué, région, plan, version | projet Production identifié et région validée | aucune preuve de périmètre ou de reprise |
| Database / Backups | disponibilité, fréquence, rétention, dernière exécution | état, dates relatives et rétention, sans URL ni téléchargement | capacité effectivement active sur le plan réel | `NOT PROVED`, RPO à revoir |
| Database / Backups ou aide de restauration | procédure de restauration et downtime annoncé | écran de confirmation non validé, sans cliquer | procédure comprise, cible contrôlée | RTO non démontrable |
| Storage / Buckets | buckets présents, taille/rétention, bucket DSAR privé | noms génériques ou masqués, statut privé et métriques | objet DSAR couvert par export séparé | fichiers non sauvegardés |
| Auth / Users et Settings | utilisateurs nécessaires et paramètres de récupération | compteurs et settings non secrets, jamais d’email complet | stratégie Auth documentée | relations Auth non prouvées |
| Project Settings / Database / Roles | rôles, ACL, MFA du compte opérateur | rôles et noms non secrets | séparation opérateur/service | accès excessif ou restauration incomplète |

### Stockage hors site éventuel

Relever le fournisseur, région, chiffrement côté serveur, versioning, rétention, suppression, coût et accès MFA. Vérifier que le chiffrement côté client est déjà appliqué par l’archive et que la clé n’est pas dans le même emplacement. Une capture doit montrer uniquement la configuration non sensible. Si le fournisseur gratuit ne fournit pas le contrôle nécessaire sans abonnement, ne pas souscrire pendant S1D-2 : marquer la preuve manquante et choisir entre limitation de périmètre, stockage contrôlé ou coût validé.

### Clés de reprise

Vérifier manuellement l’emplacement principal, la copie de secours, les personnes autorisées, la procédure de récupération, la séparation avec l’archive, la rotation et la révocation. Ne jamais copier la clé dans le dépôt, le rapport ou une capture.

## Responsabilités

- Tëer : sélection des composants, minimisation, purge avant export si applicable, format chiffré, procédure, tests locaux, contrôle post-restauration et gestion de la clé opérateur.
- Supabase : stockage et mécanismes de base/Auth/Storage selon le plan réellement souscrit ; chiffrement fournisseur, sauvegardes et restauration restent à prouver par le tableau de bord du projet.
- Vercel : variables et logs d’exécution ; aucune clé de sauvegarde ne doit y être placée si l’application n’en a pas besoin.
- Fournisseur hors site éventuel : conservation de l’archive ciphertext, accès, versioning et suppression ; à sélectionner et vérifier séparément.

La documentation juridique existante mentionne des sauvegardes chiffrées, mais cette phrase ne constitue pas une preuve de configuration ni de restauration. Aucun document juridique n’a été modifié dans S1D-2.

## Limites restantes

- aucune sauvegarde de production n’a été créée, téléchargée ou restaurée ;
- aucun plan, région, rétention, chiffrement fournisseur ou bucket Production n’a été consulté ;
- la capacité Supabase gratuite et l’existence d’une copie hors site restent non prouvées ;
- la restauration des rôles personnalisés doit être traitée séparément sans archiver de mots de passe ; le cycle local utilise les rôles standards déjà présents et un fichier ACL non sensible ;
- DSAR, effacement dans les archives, réponse aux incidents et accès staff relèvent des lots suivants et ne sont pas clos ici.
