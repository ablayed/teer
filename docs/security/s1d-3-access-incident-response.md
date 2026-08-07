# S1D-3 — accès privilégiés, journal PCD et réponse aux incidents

## Statut et frontière de preuve

Ce document couvre les contrôles locaux et l’exercice synthétique de S1D-3. Il ne
prouve pas la configuration des comptes Supabase, Vercel, Shopify Partner, GitHub,
Sentry, PostHog, Groq, Resend, Upstash ou du stockage hors site. Toute ligne
marquée « manuel » doit être vérifiée par une personne autorisée dans le compte
concerné, sans copier de secret, d’URL de connexion, de PCD ou de contenu de log.

Le schéma fournit le socle append-only attendu : `pcd_access_audit` est créé par
les migrations 0123/0124, sa lecture est RLS-scopée et ses mutations sont
bloquées par trigger. La migration additive 0125 renforce la frontière SQL de
`log_pcd_access_event` : les listes fermées, formats techniques, types JSON,
longueurs, identité de session et appartenance tenant sont maintenant validés
indépendamment du wrapper TypeScript. Elle révoque aussi l'exécution explicite
à `anon` et conserve uniquement `authenticated` et `service_role` pour les
appelants légitimes. Le contournement direct RPC est fermé localement ; les
réglages des comptes et journaux de production restent manuels.

Les contrôles ci-dessous distinguent toujours :

| Niveau | Ce que cela signifie |
|---|---|
| Règle documentée | politique attendue, non suffisante seule |
| Contrôle automatisé | code, RLS, test ou workflow versionné |
| Preuve locale | résultat obtenu avec fixtures synthétiques ou inspection du dépôt |
| Exercice simulé | scénario local sans compte fournisseur ni PCD réelle |
| Capacité fournisseur | fonctionnalité annoncée, non configuration réelle |
| Preuve distante | vérification manuelle requise dans un compte |

## Périmètre et chemins PCD

Les catégories de données protégées restent limitées aux finalités déjà déclarées
par S1C : identité/contact client, adresse de livraison, payload Shopify borné,
artefact DSAR, données de membre et données marchand nécessaires au service.
S1D-3 n’ajoute aucun champ Shopify ni aucune nouvelle collecte.

| Chemin | PCD nécessaire | Acteur autorisé | Contrôle local | Journal attendu |
|---|---|---|---|---|
| Liste, recherche et détail des commandes | identité, contact, adresse opérationnelle | membre owner/manager/agent selon capacité | session, rôle, tenant/boutique, RLS, audit avant réponse | `list_access`, `search` ou `view_detail` par requête |
| Liste et recherche clients | identité, contact, adresse | membre autorisé | RLS, rôle, quota recherche, audit fail-closed | `search` ou `list_access` |
| Actions de livraison et partage WhatsApp | contact, adresse | utilisateur authentifié dans son tenant | identifiant de commande côté serveur, quota, audit avant partage | `external_share` |
| Rapport PDF / exports | données nécessaires au rapport | owner/manager ; réauthentification récente | rôle, tenant/boutique, bornes, quota, `no-store`, audit | `generate_export` |
| DSAR | artefact d’export | owner/manager du tenant et boutique | autorisation one-shot, réauthentification, quota, chemin serveur | génération puis `download_export` |
| Webhooks Shopify et synchronisation | payload entrant et PCD nécessaires à la synchronisation | service fermé, boutique résolue côté serveur | HMAC, service role hors navigateur, tenant/boutique, audit borné | `shopify_payload`, résultat technique |
| Assistant IA / feedback / Resend | texte ou données strictement nécessaires | membre dans son tenant | détection déterministe, refus avant transmission, sanitisation | `ai_processing` ou `support_submission` |
| Sauvegarde/restauration | composants explicitement retenus par S1D-2 | opérateur de reprise dédié | archive chiffrée, cible locale explicite, clé séparée | hors journal applicatif ; registre opérateur sans PCD |
| Logs, Sentry, PostHog et traces | aucune PCD | processus de télémétrie | allow-list et redaction | ne jamais y déposer le contenu PCD |

Les listes sont auditées par requête, pas par ligne, afin de garder un signal
utile. Un échec de l’audit obligatoire ferme la réponse contenant les PCD. Les
refus d’autorisation significatifs sont signalés par l’événement Sentry structuré
`authorization_failure`, sans contenu libre ; la disponibilité et la rétention
Sentry restent à prouver manuellement.

## Matrice des acteurs et accès

| Acteur/service | Authentification et assurance | Données/opérations | Cross-tenant | Export et journal | Révocation / preuve manquante |
|---|---|---|---|---|---|
| Propriétaire marchand | session Supabase ; réauth pour export/DSAR ; MFA distante à confirmer | données de son tenant, gestion des membres, traces de son tenant | interdit par RLS et contrôles serveur | export borné ; lecture owner-only de `pcd_access_audit` | déconnexion/révocation locale possible ; MFA et membres manuels |
| Administrateur de la plateforme | aucun rôle applicatif distinct trouvé | aucun accès PCD permanent défini | interdit par modèle cible | aucun accès applicatif prévu | comptes fournisseurs et accès humain à inventorier manuellement |
| Manager marchand | session Supabase ; capacité définie par rôle | commandes, clients, opérations et exports autorisés par produit | interdit par RLS | accès PCD journalisé ; pas de lecture du journal global | session révoquable ; MFA et revue distante |
| Vendeur / agent | session Supabase ; rôle `agent` | file d’appel et opérations autorisées ; pas finances/membres | interdit par RLS | lectures PCD ciblées journalisées | session révoquable ; MFA distante |
| Livreur | aucune capacité staff spéciale identifiée ; accès produit borné | données nécessaires à la livraison uniquement | interdit | partage ou consultation explicitement journalisé | revue manuelle du compte et de la révocation |
| Non authentifié | aucun accès | aucune PCD ; erreurs génériques | interdit | pas de bruit d’audit pour les visiteurs | contrôle route/RLS local |
| Service applicatif | variables serveur ; HMAC ou secret de route selon chemin | synchronisation, DSAR et tâches prévues ; service role non navigateur | tenant/boutique explicitement fournis et validés | `actor_kind=service`, `service_kind` fermé | rotation manuelle des credentials ; provenance fournisseur à confirmer |
| Webhook Shopify | HMAC puis résolution de boutique | payload strictement nécessaire et traitement idempotent | interdit sans boutique/tenant valide | événement service sans payload brut | secret HMAC/Partner manuel |
| Tâche interne / cron | secret de route ou exécution contrôlée | tâche explicitement déclarée | aucun accès implicite | `service_kind=cron` si PCD | révocation/rotation manuelle |
| Support Tëër | aucun mécanisme support PCD trouvé dans le dépôt | support sans accès PCD par défaut ; demander au marchand une action ciblée | interdit | aucun accès permanent ; exception future obligatoirement bornée | équipe et MFA manuelles ; ne pas créer d’impersonation dans S1D-3 |
| Développeur | accès dépôt et outils, non équivalent à un accès métier | données synthétiques Local/Test/Preview seulement | production interdite par politique | CI et observabilité sans PCD | membres, 2FA, environnements et logs manuels |
| Accès direct Supabase | console/DB fournisseur | aucun accès humain présumé conforme | doit être limité par rôle fournisseur | journal fournisseur à vérifier | membres, rôles, MFA, SSL et connexions manuels |
| Accès sauvegardes | opérateur de reprise dédié | archives chiffrées, jamais clé dans l’archive | aucun accès métier | registre sans contenu | emplacement, MFA, rotation et preuve de récupération manuels |
| Observabilité | SDK ou membres fournisseur | événements sanitizés et métadonnées techniques | pas de PCD | rétention/accès fournisseurs manuels | membres, rôles, suppression manuels |
| GitHub Actions / artefacts | secrets GitHub injectés au job | fixtures et rapports ; pas de `.env*` dans les artefacts déclarés | production interdite | Gitleaks CI ; rapports 7/14 jours selon workflow | membres, 2FA, permissions et rétention manuels |
| Export DSAR | propriétaire/manager après autorisation one-shot | artefact correspondant à la demande | tenant + boutique + acteur | génération/téléchargement séparés | expiration/purge locale ; Storage et accès manuels |

Le dépôt ne contient pas de compte staff Tëër permanent, de compte partagé,
d’impersonation ou de porte dérobée applicative identifiés pendant l’inventaire.
Cette absence de code ne prouve pas l’absence d’un membre humain dans les
consoles fournisseurs.

## Modèle de privilèges

- Refus par défaut : une route non authentifiée, un rôle non autorisé, un tenant
  inconnu ou une boutique hors tenant reçoit un refus générique.
- Moindre privilège : `owner`, `manager` et `agent` sont les seuls rôles métier
  locaux ; la matrice de capacités est centralisée dans
  `lib/team/permissions.ts`.
- Isolation : les tables tenant portent RLS `FORCE` selon le sweep existant ; les
  tests RLS vérifient le déni cross-tenant et la role-escalation.
- Service-to-service : le service role n’est pas exposé au navigateur. Les RPC
  d’audit dérivent l’acteur humain de `auth.uid()` et n’acceptent pas un acteur
  fourni par le client. Un service doit déclarer une valeur `service_kind` fermée.
- Support : pas d’accès PCD par défaut. Une future exception devra être
  nominative, justifiée par un ticket non sensible, limitée à un tenant/boutique,
  expirante, journalisée à l’ouverture et à la fermeture, puis révoquée.
  Aucune fonction d’impersonation n’est créée dans S1D-3.
- Développement : aucune PCD de production dans Local, Test/CI ou Preview ; les
  fixtures et traces doivent rester synthétiques.

## Journal PCD et append-only

`pcd_access_audit` conserve seulement : date serveur, tenant/boutique, acteur
humain dérivé ou type de service, action, catégorie, finalité, résultat, type et
identifiant technique minimal de ressource, surface et métadonnées allow-listées.

Sont explicitement exclus : nom, téléphone, adresse, email, recherche, payload
Shopify, corps DSAR, token, cookie, header d’autorisation, URL avec credentials,
exception, message libre, contenu de sauvegarde et anciennes/nouvelles valeurs
de PCD.

La table est RLS `FORCE`, lisible par les owners du tenant, non inscriptible
directement par `PUBLIC`, `anon` ou `authenticated`, et protégée contre UPDATE et
DELETE par trigger. La fonction de maintenance est réservée au service role et
requiert un GUC explicite ; elle n’est pas un chemin applicatif normal.

La migration 0125 rend la validation SQL autonome : chaque action, acteur,
service, catégorie, finalité, résultat, ressource et surface appartient à une
liste fermée ; les métadonnées sont un objet de huit clés maximum, sans null,
tableau, objet imbriqué, texte libre, contrôle, email, téléphone, URL, jeton ou
en-tête reconnaissable. Les identifiants d’idempotence sont limités à 96
caractères techniques. Les erreurs sont des codes génériques et ne reprennent
pas les valeurs rejetées. Les tests RPC directs couvrent les tentatives de
contournement, la falsification de tenant, `anon`, et l’immutabilité.

La clé d’idempotence empêche le doublon technique. En cas d’échec d’écriture,
les chemins PCD concernés sont fail-closed lorsqu’ils vont rendre un contenu,
notamment DSAR. Un refus RLS brut ne crée pas automatiquement un événement PCD
si aucun chemin serveur n’a pu qualifier la ressource ; il est alors couvert par
le signal d’autorisation structuré et la preuve fournisseur Sentry reste
manuelle. Cette limite est explicitement retenue plutôt que d’inventer une
ligne d’audit sans contexte fiable.

## Détection locale minimale

`lib/security/pcd-anomaly-detection.ts` analyse uniquement des événements déjà
sanitisés et ne contacte aucun fournisseur. Les règles MVP sont déterministes :

| Règle | Seuil local | Sévérité |
|---|---:|---|
| Refus cross-tenant répétés | 3 dans 15 minutes par acteur | haute |
| Accès support exceptionnel | tout événement explicitement marqué | haute |
| Export excessif | 5 générations/téléchargements dans 15 minutes | haute |
| Même acteur sur plusieurs tenants | plus d’un tenant dans le lot analysé | haute |
| Échecs d’autorisation privilégiée | 5 dans 15 minutes par acteur | moyenne |
| Tentative de mutation de l’audit | tout événement | critique |
| Usage d’un credential révoqué | tout événement | critique |
| Service role inattendu | événement explicitement marqué | critique |

Ces règles ne constituent ni un SIEM ni une alerte de production. Elles produisent
des métadonnées de règle, sévérité, compte d’éléments et identifiant technique
non sensible. L’envoi, le routage, la rétention et l’astreinte doivent être
validés dans les comptes fournisseurs lors de la preuve manuelle.

## Réponse aux incidents

### Classification

1. **Événement bénin** : refus isolé, erreur de session ou faux positif sans
   indice d’accès.
2. **Incident suspecté** : règle d’anomalie déclenchée, credential exposé ou
   comportement non expliqué.
3. **Incident confirmé** : accès ou opération PCD non autorisé établi.
4. **Incident PCD critique** : fuite, accès transversal confirmé, journal altéré
   ou sauvegarde compromise.

La gravité peut être relevée sans modifier la preuve initiale. Ne pas fixer ici
de délai juridique : vérifier les obligations contractuelles, Shopify, des
fournisseurs et des autorités compétentes avec validation juridique au moment
des faits.

### Rôles réalistes

Pour une exploitation initiale par une personne :

- **Responsable de décision** : Ablaye ou la personne officiellement désignée ;
- **Responsable technique** : la même personne jusqu’à désignation d’un relais ;
- **Communication** : la même personne, avec validation juridique avant tout
  message externe ;
- **Secours** : contact nominatif à désigner avant lancement ; ne pas inventer
  une identité dans le registre ;
- **Fournisseurs** : Supabase, Vercel, Shopify Partner, GitHub et fournisseur
  d’observabilité concernés par l’incident.

### Séquence opératoire

1. détecter et ouvrir un identifiant d’incident sans PCD ;
2. qualifier l’acteur, le tenant, la ressource et la fenêtre sans copier la
   donnée ;
3. préserver les identifiants techniques, horodatages, événements sanitizés et
   décisions ;
4. confiner le chemin précis : session, intégration ou credential concerné ;
5. révoquer les sessions/credentials puis faire tourner les secrets dans l’ordre
   documenté ci-dessous ;
6. vérifier l’étendue et l’absence de cross-tenant ;
7. restaurer ou corriger uniquement après sauvegarde/reprise contrôlée S1D-2 ;
8. valider les contrôles avant reprise ;
9. évaluer les communications marchands, contractuelles, Shopify et
   réglementaires avec validation juridique ;
10. clôturer avec critères, responsable, preuves et actions correctives ;
11. faire un retour d’expérience et planifier un exercice périodique.

### Registre sans PCD

```text
incident_id:
opened_at:
closed_at:
severity:
systems:
data_categories:
approximate_account_or_merchant_count:
detector_rule:
timeline_and_decisions:
containment_actions:
revocation_and_rotation_actions:
evidence_references:
internal_communications:
external_communications:
legal_and_contractual_review:
closure_criteria:
corrective_actions:
owner:
```

Les champs `data_categories` et `approximate_account_or_merchant_count` sont des
catégories et estimations, jamais des lignes PCD ni des exports.

## Révocation et confinement

| Compromission | Action immédiate locale | Action distante manuelle |
|---|---|---|
| Session utilisateur | marquer la session synthétique/concernée révoquée, déconnecter et contrôler le tenant | révoquer sessions Supabase et vérifier MFA |
| Compte privilégié | suspendre l’accès et préserver les preuves | désactiver/réinitialiser le compte, revoir les membres |
| Service role Supabase | arrêter le composant dépendant et refuser les opérations non essentielles | révoquer/réémettre la clé, vérifier logs et membres |
| Secret client ou HMAC Shopify | suspendre l’intégration affectée, refuser les appels non vérifiables | régénérer dans Partner, vérifier webhooks et boutiques |
| Clé active ou précédente Shopify | empêcher une rotation destructive ; conserver le couple transitoire | générer nouvelle clé, re-chiffrer contrôlé, retirer l’ancienne après preuve |
| Clé de sauvegarde | suspendre l’accès aux archives et ne pas détruire la seule copie | récupérer la copie de secours, tourner la clé, vérifier une restauration |
| Credential Vercel | stopper l’usage et limiter le déploiement | révoquer/réémettre, revoir variables par environnement |
| Credential GitHub Actions | suspendre le workflow concerné | révoquer/réémettre secret, vérifier journaux et artefacts |
| Sentry/PostHog/Groq/Resend/Upstash | désactiver l’appel non indispensable | révoquer/réémettre, vérifier rétention, membres et suppression |

Chaque rotation doit conserver une preuve non sensible de l’heure, du périmètre,
du résultat et du rollback. Aucune rotation réelle n’est exécutée par S1D-3.

## Exercice local exécuté

Le test `tests/unit/security/s1d3-access-incident.test.ts` simule :

1. trois refus cross-tenant avec identifiants et données synthétiques ;
2. émission de l’indicateur `repeated_cross_tenant_denials` ;
3. tentative de mutation de l’audit et usage d’un credential synthétique révoqué ;
4. classement critique et suppression du credential d’un registre local simulé ;
5. vérification que les résultats et la télémétrie ne contiennent pas le marqueur
   PCD synthétique ;
6. scénarios complémentaires d’export excessif, multi-tenant et rafale de refus.

Cet exercice mesure une capacité locale simulée, pas un temps de détection ou de
confinement en production. Les tests RLS S1C existants constituent la preuve
comportementale séparée du refus cross-tenant réel dans Supabase local.

## Checklist manuelle de production

Ne relever qu’un statut, une date, une rubrique et un identifiant logique masqué.
Une capture acceptable ne doit contenir ni secret, token, PCD, URL de connexion,
payload ou contenu sensible de journal.

| Fournisseur / rubrique | À vérifier | Capture acceptable | Attendu / conséquence |
|---|---|---|---|
| Supabase → Members / Organization | propriétaires, membres nominatifs, rôles, MFA | noms masqués, rôles et statut MFA | moindre privilège ; sinon preuve absente |
| Supabase → Auth / sessions | sessions, révocation, MFA/AAL | statut et procédure sans identifiant personnel | révocation opérable ; sinon manuel requis |
| Supabase → Database / Logs | connexions, accès admin, rétention | période, statut, durée | journal exploitable ; sinon production non prouvée |
| Supabase → API / Database | service role, accès directs, SSL/réseau | noms de réglages et statut, valeurs masquées | service role serveur-only ; sinon blocage de preuve |
| Vercel → Team / Project Members | membres, rôles, 2FA | rôles et 2FA | comptes nominatifs ; sinon revue requise |
| Vercel → Environments / Logs | variables Production/Preview, accès logs, historique | noms d’environnement, noms de variables masqués | séparation et logs sans secret |
| Shopify Partner | propriétaires, collaborateurs, 2FA, credentials, app history | rôles, statuts, dates | aucun partage permanent non justifié |
| GitHub → Settings / Actions | membres, 2FA, permissions, environnements, secrets, audit log | statuts, rétention, noms logiques masqués | secrets masqués et artefacts limités |
| GitHub → Actions artifacts | rapports, traces, rétention | type d’artefact et durée | aucune PCD ; supprimer toute trace non synthétique |
| Sentry / PostHog | membres, rôles, MFA, région, rétention, redaction | statuts et réglages | aucun contenu PCD ; sinon production non prouvée |
| Groq / Resend / Upstash | membres, rôles, MFA, contrôles data/rétention | statut, région, date | minimisation et révocation opérables |
| Stockage hors site S1D-2 | accès, MFA, rétention et alertes | réglages non sensibles | clé séparée et récupération testée |

## Preuves locales obtenues et limites

- `lib/actions/safe-action.ts` centralise l’authentification et la garde de rôle ;
  les refus `FORBIDDEN` sont transformés en événement Sentry structuré sans
  message d’exception.
- `lib/team/permissions.ts` définit les trois rôles métier et leurs capacités.
- `lib/security/pcd-access-audit.ts` conserve la première barrière de refus des
  valeurs texte libres ; la migration 0125 ajoute la même borne à la RPC SQL.
  Les tests directs et RLS prouvent le writer fail-closed, la dérivation de
  l’acteur, l’isolation et l’append-only, y compris hors wrapper TypeScript.
- `lib/security/telemetry-sanitize.ts` et les tests S1C prouvent la suppression
  des URLs, recherches, payloads et textes libres aux frontières Sentry/PostHog.
- `lib/security/pcd-anomaly-detection.ts` et son test ajoutent la détection locale
  proportionnée ; aucune alerte distante n’est envoyée.
- Les workflows CI n’écrivent plus de clés dans les fichiers d’environnement de
  build ; les variables nécessaires sont injectées au processus concerné et les
  fichiers temporaires sont supprimés avec `if: always()` avant les artefacts.
- Gitleaks reste disponible dans le workflow CI, mais l’exécutable n’est pas
  installé localement dans ce lot ; aucune valeur n’a été inspectée.

Restent non prouvés : membres et MFA humains, configuration RLS/SSL et projet de
production réellement utilisé, rétention et accès des logs fournisseurs,
routage d’alertes, service role et accès DB directs, rétention effective des
artefacts, et exécution CI de Gitleaks. La migration 0125 et sa preuve locale ne
valent pas preuve de configuration de production.

Les documents juridiques ne sont pas modifiés. Toute affirmation de conformité
technique dans le DPA ou la politique de confidentialité doit être recoupée avec
ces preuves avant une conclusion juridique ou une soumission Shopify.

## Éléments hors périmètre

S1D-4, SHOPIFY-PRECHECK, soumission Shopify, webhooks HMAC, finance manager,
Phase 1 Workspace/RLS, S1D-2 sauvegarde/restauration, WooCommerce et YouCan ne
sont ni corrigés ni clôturés par ce lot.
