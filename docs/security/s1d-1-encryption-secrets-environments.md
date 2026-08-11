# S1D-1 — chiffrement, secrets et séparation des environnements

## Périmètre

Ce document couvre uniquement les contrôles locaux de chiffrement, de configuration,
de secrets et de séparation Local/Test/Preview/Production. Il ne prouve pas la
configuration distante Supabase, Vercel, Shopify ou des autres fournisseurs.

Les preuves distantes doivent être relevées par une personne autorisée dans les
tableaux de bord concernés, sans copier de secret dans le dépôt ou dans ce dossier.

## Règles d’environnement

| Environnement | Données autorisées | Ressources autorisées | PCD de production |
|---|---|---|---|
| Local | données synthétiques | services locaux | interdite |
| Test/CI | données synthétiques | services éphémères ou locaux | interdite |
| Preview | données synthétiques ou anonymisées | ressources Preview dédiées | interdite |
| Production | PCD réelles minimisées | ressources de production | autorisée selon finalité |

Une PCD de production ne doit jamais être copiée vers Local, Test, CI ou Preview.
Toute fixture exportée doit être synthétique ou anonymisée avant d’entrer dans ces
environnements. Cette règle est opérationnelle ; elle ne constitue pas une preuve
que la séparation distante est déjà configurée.

`lib/security/environment-validation.ts` refuse en production :

- les URL HTTP, localhost, loopback et domaines de test/localité ;
- l’absence de `SHOPIFY_TOKEN_ENCRYPTION_KEY` ou une clé qui n’est pas une clé AES-256-GCM hexadécimale ;
- l’absence de secrets requis pour Supabase, Resend, cron et Upstash ;
- les paires Shopify partielles ;
- les modes E2E, démonstration et test-only ;
- une clé précédente invalide ou identique à la clé active.

Les environnements Local et Preview conservent leur souplesse existante. La détection
de production privilégie `VERCEL_ENV=production` ; hors Vercel, elle retombe sur
`NODE_ENV=production`.

## Modèle de chiffrement

### Tokens Shopify

`lib/shopify/crypto.ts` utilise AES-256-GCM avec :

- clé de 32 octets représentée par 64 caractères hexadécimaux ;
- IV aléatoire de 12 octets par chiffrement ;
- tag d’authentification de 16 octets ;
- format stocké `iv:tag:ciphertext` ;
- erreur générique lors d’une altération, d’une mauvaise clé ou d’un ciphertext invalide.

Le chiffrement utilise toujours la clé active. Pendant une rotation contrôlée,
`SHOPIFY_TOKEN_ENCRYPTION_KEY_PREVIOUS` permet une lecture transitoire avec l’ancienne
clé. Aucun ré-encryptage distant ni migration de données n’est effectué par S1D-1.

### PCD métier

Les PCD de `customer`, `orders`, `delivery_address` et `webhook_event` restent dans
les colonnes opérationnelles Supabase afin de permettre RLS, recherche, rétention et
traitement Shopify. Leur chiffrement applicatif n’est pas ajouté automatiquement :
la première preuve attendue est le chiffrement géré par le fournisseur et le TLS
effectivement configuré.

## Inventaire sans valeurs sensibles

| Donnée ou secret | Finalité | Origine → destination | Stockage / repos | Transit | Accès logique | Rotation / révocation | Journalisation potentielle | Preuve locale | Preuve distante manquante |
|---|---|---|---|---|---|---|---|---|---|
| Token d’accès Shopify | Appels Admin API | Shopify → serveur Tëër → Supabase | colonne chiffrée AES-256-GCM | HTTPS | serveur, service role | refresh Shopify ; révocation à la désinstallation ; rotation de clé transitoire | jamais en clair par le code ; erreurs génériques | `lib/shopify/crypto.ts`, `lib/shopify/token.ts`, tests crypto | chiffrement DB/Storage, accès opérateurs, preuve production |
| Secret client Shopify / secret HMAC | OAuth et vérification webhooks | Vercel → serveur Tëër | variable serveur | HTTPS vers Shopify | serveur uniquement | rotation Partner puis réinstallation/révocation contrôlée | non loggé volontairement | `lib/env.ts`, `lib/shopify/apps.ts`, vérificateur HMAC | variables Vercel, membres Partner, rotation réelle |
| Clé active de chiffrement des tokens | Chiffrer/déchiffrer les tokens | opérateur → Vercel | variable serveur | accès dashboard chiffré selon fournisseur | serveur et opérateurs autorisés | double clé temporaire, re-chiffrement contrôlé ultérieur, révocation après preuve | valeur jamais affichée | `lib/shopify/crypto.ts`, validation S1D-1 | stockage, accès, rotation et révocation Vercel |
| Clé précédente de chiffrement | Lecture pendant rotation | opérateur → Vercel | variable serveur temporaire | accès dashboard | serveur et opérateurs autorisés | suppression après inventaire et re-chiffrement | jamais loggée | support non destructif ajouté par S1D-1 | preuve de suppression et contrôle de fin de rotation |
| URL et clé publique Supabase | API DB/Auth/Storage | Vercel/navigateur → Supabase | URL et clé publique | HTTPS requis en production | navigateur et serveur selon clé | rotation Supabase si nécessaire | URL sans PCD ; clé publique | `lib/env.ts`, clients Supabase | projet, région, TLS et séparation distante |
| Service role Supabase | traitements serveur privilégiés | Vercel → Supabase | variable serveur | HTTPS API ; SSL DB à vérifier | serveur uniquement | révocation/réémission Supabase | jamais affiché par le code | `lib/env.ts`, clients serveur | accès humains, MFA, rotation et SSL DB |
| Credentials DB | SQL et maintenance | opérateur/CI → Supabase | variables/outils hors dépôt | SSL à vérifier pour Postgres | opérateurs/CI autorisés | rotation Supabase | ne doivent pas apparaître dans CI/artifacts | `.gitignore`, CI synthétique | inventaire des accès et SSL enforcement |
| Secrets cron | routes internes | Vercel cron → serveur | variable serveur | HTTPS | routes internes | rotation coordonnée avec déploiement | comparaison uniquement, jamais valeur | routes cron et validation S1D-1 | variable Production, historique d’accès |
| Sentry DSN | télémétrie d’erreurs | application → Sentry | variable publique | HTTPS requis | SDK et Sentry | réémission côté fournisseur | événements sanitizés | `sentry.*.config.ts`, sanitisation | projet, rétention, membres, région et réglages |
| PostHog key/host | analytics | navigateur → PostHog | clé publique + host | HTTPS requis | navigateur/PostHog | rotation côté projet | `before_send` sanitizé | `lib/analytics/posthog.ts` | host/région, rétention, membres, consentement |
| Groq API key | assistant IA | Vercel → Groq | variable serveur | HTTPS | serveur uniquement | réémission fournisseur | texte PCD refusé par garde locale ; config fournisseur non prouvée | route IA, DLP | Data Controls/ZDR et accès projet |
| Resend API key | courriels transactionnels | Vercel → Resend | variable serveur | HTTPS | serveur uniquement | réémission fournisseur | contenu contrôlé côté application | `lib/env.ts`, email | membres, logs et rétention fournisseur |
| Upstash URL/token | rate limiting | Vercel → Upstash | URL + variable serveur | HTTPS requis | serveur uniquement | réémission fournisseur | clés de bucket seulement | rate limit, validation S1D-1 | projet, membres et rétention |
| GitHub Actions credentials | CI et artefacts | GitHub Actions | secrets GitHub | HTTPS GitHub | workflow et membres autorisés | rotation GitHub | Gitleaks et logs masqués | `.github/workflows/ci.yml`, `.gitleaks.toml` | membres, MFA, permissions, artefacts |
| Artefacts DSAR | export légal temporaire | serveur → Supabase Storage privé | bucket privé, TTL applicatif | HTTPS | routes DSAR autorisées | expiration/purge S1D-2 | métadonnées techniques uniquement | `lib/shopify/dsar.ts`, tests S1C | chiffrement Storage, accès et rétention réelle |
| `customer` | identité/contact/adresse Shopify | Shopify → Supabase | colonnes opérationnelles | HTTPS API | RLS/service role | purge PCD prévue | accès PCD audit ; pas de valeurs télémétrie | migrations/tests S1C | chiffrement DB et production |
| `orders` | livraison/synchronisation Shopify | Shopify → Supabase | colonnes opérationnelles et adresse livraison | HTTPS API | RLS/service role | rétention PCD prévue | audit technique, payloads bornés | synchronisation/tests S1C | chiffrement DB et copies inter-environnements |
| `delivery_address` | livraison | UI/Shopify → Supabase | colonnes opérationnelles | HTTPS API | RLS/service role | rétention PCD prévue | audit sans valeur | migrations/tests S1C | chiffrement DB et accès opérateurs |
| `webhook_event` | retry/idempotence Shopify | Shopify → Supabase | payload JSONB temporaire | HTTPS entrant + HMAC | service role | purge/nullification prévue | topic, état, codes contrôlés | route webhook, migration 0121 | activation migration et purge production |

## Rotation et révocation

Le format historique ne contient pas de version de clé. S1D-1 ne modifie pas le
schéma et ne ré-encrypte aucune donnée distante. La procédure sûre est donc :

1. générer une nouvelle clé active hors du dépôt et hors des logs ;
2. placer l’ancienne dans `SHOPIFY_TOKEN_ENCRYPTION_KEY_PREVIOUS` et la nouvelle dans `SHOPIFY_TOKEN_ENCRYPTION_KEY` ;
3. déployer et vérifier la lecture des tokens existants ;
4. laisser les écritures/refresh produire uniquement avec la clé active ;
5. effectuer ultérieurement un re-chiffrement contrôlé et mesuré ;
6. vérifier l’absence d’échec de déchiffrement ;
7. retirer puis révoquer l’ancienne clé ;
8. conserver la preuve de rotation et le plan de rollback.

Si une rotation doit distinguer durablement plusieurs générations, une évolution de
schéma sera nécessaire et devra être traitée dans un lot séparé avec arrêt préalable.

## Logs et artefacts

Les contrôles locaux disponibles sont :

- sanitisation Sentry avant envoi ;
- filtrage PostHog `before_send` ;
- messages d’erreur server actions génériques ;
- absence de token en clair dans OAuth et refresh Shopify ;
- Gitleaks sur l’historique complet dans la CI ;
- fixtures CI synthétiques ;
- traces Playwright et rapports à rétention limitée.

Les artefacts Playwright ne doivent être produits qu’avec des données synthétiques.
La CI conserve actuellement les rapports/traces 7 jours et le rapport HTML fusionné
14 jours. L’accès GitHub et la purge effective restent des preuves distantes.

## Checklist de preuves distantes à compléter manuellement

Pour chaque ligne, relever uniquement un statut, une date, une rubrique et, si besoin,
une capture masquée. Ne jamais relever de valeur, token, secret, PCD ou export brut.

### Supabase

- Dashboard : projet de production, région et plan.
- Database > SSL Configuration : `Enforce SSL on incoming connections` activé.
- Database/Storage : chiffrement au repos et bucket DSAR privé.
- Project Settings > API : aucune copie de service role dans Preview/Local/CI.
- Organization/Project members : comptes nominatifs, rôles minimaux, MFA.
- Environments : projets Production et non-Production distincts, ou justification approuvée.
- Relever : nom logique, région, statut des options, date, rôle de l’observateur.
- Masquer : clés, tokens, chaînes de connexion et PCD.

### Vercel

- Project Settings > Environments : variables séparées Local/Preview/Production.
- Chaque variable sensible est attachée au seul environnement attendu.
- Team Members : membres nominatifs, rôles minimaux, 2FA.
- Deployments/Logs : accès limité et absence de secret dans les logs.
- Domains : domaine de production HTTPS.
- Relever : noms d’environnement, statuts, rôles, dates et domaine sans query string.
- Masquer : valeurs de variables, tokens, URLs signées et données de logs.

### Shopify Partner, GitHub et autres fournisseurs

- Shopify Partner : collaborateurs, rôles, 2FA, credentials associés à la bonne app et scopes ; ne relever que statuts et dates.
- GitHub : membres, MFA, permissions Actions, secrets par environnement et rétention/accès des artefacts.
- Sentry/PostHog : projet, région, rétention, suppression, membres, rôles, MFA et masquage.
- Groq/Resend/Upstash : Data Controls ou équivalent, région, rétention, membres, rôles et MFA.
- Masquer partout les clés, tokens, e-mails client, payloads et URLs signées.

## Limites

Ce document ne prouve pas les sauvegardes/restaurations, les accès staff ou la
réponse aux incidents, réservés à S1D-2 et S1D-3. Il ne prouve pas non plus
l’activation des migrations `0120` à `0124`, la configuration réelle des comptes
fournisseurs ou la conformité globale Shopify.
