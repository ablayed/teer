# Accord de sous-traitance (DPA)

**Version : 2.0**
**Dernière mise à jour : 2 novembre 2026**

> **BROUILLON — publication suspendue.** Les coordonnées de l’éditeur et du support restent à fournir par le fondateur.

## Parties

- **Responsable de traitement** : le commerçant qui utilise Tëër pour gérer ses ventes et commandes.
- **Sous-traitant** : **[[À_FOURNIR : ÉDITEUR_NOM]]**, situé à **[[À_FOURNIR : ÉDITEUR_LOCALISATION]]**, opérant le service Tëër (« Tëër »).
- **Contact support et demandes relatives aux données** : **[[À_FOURNIR : CONTACT_SUPPORT]]**.

## 1. Objet et durée

Le présent accord encadre le traitement par Tëër, pour le compte du commerçant, des données de ses clients finaux traitées pour fournir le cockpit COD. Il s’applique pendant l’utilisation du service par le commerçant et prend fin avec celle-ci, sous réserve des opérations de suppression et des obligations applicables.

## 2. Nature, finalités et données

Tëër reçoit, enregistre, organise, consulte, met à jour et supprime des données afin de saisir ou importer des commandes, suivre leur livraison, les encaissements COD, les stocks et les opérations des livreurs.

Les données peuvent comprendre le nom, le téléphone, l’adresse de livraison et les informations de commande des clients finaux, lorsqu’elles sont fournies par le commerçant ou sa boutique connectée. Les catégories de personnes concernées sont les clients finaux du commerçant.

## 3. Instructions et obligations du commerçant

Le commerçant détermine les finalités et moyens du traitement de ses données client. Il confirme qu’il dispose des droits et instructions nécessaires pour transmettre ces données à Tëër et informer les personnes concernées. Tëër traite les données pour fournir le service et selon les instructions du commerçant, sauf obligation légale applicable.

## 4. Confidentialité et sécurité

Le code du service met en œuvre des connexions HTTPS/TLS aux services distants, le chiffrement des jetons Shopify stockés, l’isolation des données entre commerçants par RLS et un contrôle des actions selon le rôle de l’utilisateur. Ces mesures décrivent les contrôles présents dans le code et ne constituent ni une certification ni une garantie d’absence d’incident.

## 5. Sous-traitants ultérieurs et plateformes connectées

Le commerçant autorise l’utilisation des services ci-dessous pour fournir les fonctionnalités de Tëër. Les lieux propres au compte ou au déploiement, lorsqu’ils ne peuvent être établis depuis le dépôt, sont indiqués « à confirmer ».

| Prestataire ou plateforme | Fonction | Localisation documentée |
|---|---|---|
| Supabase | Base de données et authentification | Région AWS choisie pour le projet ; région active à confirmer |
| Vercel | Hébergement et exécution de l’application et des tâches planifiées | Région du déploiement à confirmer |
| Sentry | Diagnostic des erreurs et de la performance | Région de l’organisation à confirmer |
| PostHog | Mesure des pages consultées | Hôte États-Unis par défaut dans le code ; configuration active à confirmer |
| Upstash Redis | Limitation du débit des demandes | Région de la base à confirmer |
| Upstash QStash | Planification et livraison du balayage des webhooks | Région de l’instance à confirmer |
| Resend | Envoi de certains courriels transactionnels | Données stockées aux États-Unis |
| Groq | Traitement des requêtes de l’assistant IA | Données retenues stockées sur des buckets GCP situés aux États-Unis |
| Shopify | Plateforme de commerce connectée et source de données | Traitement possible dans les pays où Shopify, ses sociétés affiliées ou prestataires sont établis |
| WooCommerce | Connecteur de boutique | Hébergement propre à la boutique du commerçant, à confirmer selon son fournisseur |

Le commerçant peut demander des informations complémentaires sur ces services à **[[À_FOURNIR : CONTACT_SUPPORT]]**. Les localisations des comptes Supabase, Vercel, Sentry, PostHog et Upstash doivent être vérifiées avant publication.

## 6. Assistance aux demandes des personnes

Le commerçant reçoit les demandes de ses clients finaux. Tëër met à sa disposition les fonctions prévues dans le service et les mécanismes de conformité Shopify utilisés pour aider à répondre aux demandes d’accès et d’effacement.

## 7. Incidents

Tëër informera le commerçant d’un incident de données personnelles dont il a connaissance, selon les informations disponibles et dans les délais applicables. Les coordonnées de notification sont celles du compte commerçant et du contact support indiqué dans le présent accord.

## 8. Conservation, restitution et suppression

Les règles de rétention appliquées aux données Shopify comprennent :

- adresse de commande : suppression 90 jours après la finalisation de la commande ;
- identité d’un client Shopify : suppression après 12 mois d’inactivité, si les conditions de purge sont réunies ;
- artefact DSAR temporaire : suppression après 24 heures.

À la fin de l’utilisation du service, les données sont supprimées selon les mécanismes et délais applicables au service. Toute durée précise non indiquée ci-dessus reste à confirmer.

## 9. Audit et contact

Le commerçant peut adresser ses demandes raisonnables d’information sur le traitement au contact support : **[[À_FOURNIR : CONTACT_SUPPORT]]**.
Éditeur : **[[À_FOURNIR : ÉDITEUR_NOM]]**, **[[À_FOURNIR : ÉDITEUR_LOCALISATION]]**.
