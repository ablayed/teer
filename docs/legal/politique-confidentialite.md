# Politique de confidentialité

**Version : 2.0**
**Dernière mise à jour : 2 novembre 2026**

> **BROUILLON — publication suspendue.** Les coordonnées réelles de l’éditeur et du support restent à fournir par le fondateur.

## 1. Éditeur et contact

Tëër est édité par **[[À_FOURNIR : ÉDITEUR_NOM]]**, situé à **[[À_FOURNIR : ÉDITEUR_LOCALISATION]]**.
Contact relatif aux données et au support : **[[À_FOURNIR : CONTACT_SUPPORT]]**.

## 2. Service et rôles

Tëër est un cockpit COD pour commerçants qui vendent via Shopify ou par saisie manuelle de commandes provenant notamment de WhatsApp, TikTok, Facebook et du téléphone.

Pour les données du compte et de l’équipe Tëër détermine les finalités du service. Pour les données des clients finaux utilisées dans les opérations du commerçant, celui-ci détermine les finalités et Tëër les traite pour son compte, selon le DPA.

## 3. Données traitées

Selon les fonctionnalités utilisées, Tëër traite :

- les données du compte et de l’équipe, dont l’adresse e-mail, les informations de profil, les rôles et les données d’authentification ;
- les données de commande saisies par le commerçant ou reçues d’une boutique connectée : produits, montants, statut, dates et canal d’origine ;
- les données de clients finaux présentes dans ces commandes : nom, téléphone et adresse, lorsqu’ils sont fournis ;
- les informations de stock, de livraison, de livreurs et de rapprochement COD nécessaires au cockpit ;
- les données techniques nécessaires au fonctionnement, à la sécurité, à la résolution d’erreurs et à l’analyse de fréquentation ;
- les messages transmis à l’assistant IA lorsqu’il est utilisé.

Tëër ne demande pas l’adresse e-mail des clients finaux des commerçants.

## 4. Finalités

Les données servent à créer et protéger les comptes, administrer les équipes et boutiques, importer ou saisir les commandes, suivre les opérations COD, fournir l’assistance demandée, sécuriser le service, diagnostiquer les erreurs et mesurer les pages consultées. Les messages soumis à l’assistant IA sont transmis à Groq pour produire une réponse.

## 5. Services tiers et lieux de traitement

Les services suivants sont appelés par le code de Tëër. Les régions propres au compte ou au déploiement lorsqu’elles ne sont pas établies dans le dépôt sont indiquées « à confirmer ».

| Prestataire ou plateforme | Rôle dans Tëër | Localisation documentée |
|---|---|---|
| Supabase | Base de données et authentification | Région AWS choisie pour le projet ; région active à confirmer |
| Vercel | Hébergement et exécution de l’application et des tâches planifiées | Région du déploiement à confirmer |
| Sentry | Diagnostic des erreurs et de la performance | Région de l’organisation à confirmer |
| PostHog | Mesure des pages consultées | Le code utilise l’hôte États-Unis par défaut ; configuration active à confirmer |
| Upstash Redis | Limitation du débit des demandes | Région de la base à confirmer |
| Upstash QStash | Planification et livraison du balayage des webhooks | Région de l’instance à confirmer |
| Resend | Envoi de certains courriels transactionnels | Données stockées aux États-Unis ; la région d’envoi ne détermine pas la région de stockage |
| Groq | Traitement des requêtes à l’assistant IA | Les données retenues par Groq sont stockées sur des buckets GCP situés aux États-Unis |
| Shopify | Boutique connectée, source des commandes et de certaines données client | Traitement possible dans les pays où Shopify, ses sociétés affiliées ou prestataires sont établis |
| WooCommerce | Connecteur vers la boutique du commerçant | Hébergement propre à la boutique du commerçant, à confirmer selon son fournisseur |

La région exacte des comptes Vercel, Sentry, PostHog, Upstash et Supabase doit être vérifiée dans les consoles correspondantes avant publication. Les transferts effectués par ces prestataires restent soumis à leurs engagements contractuels et à leurs propres politiques.

## 6. Conservation

Les règles de rétention appliquées aux données Shopify comprennent :

- l’adresse de commande est supprimée 90 jours après la finalisation de la commande ;
- l’identité d’un client Shopify est supprimée après 12 mois d’inactivité, si les conditions de purge sont réunies ;
- un artefact DSAR temporaire est supprimé après 24 heures.

Les autres durées dépendent de la finalité, des règles de compte et des obligations applicables. Une durée précise pour chaque catégorie de données de compte reste à confirmer avant publication.

## 7. Sécurité

Le code impose des connexions HTTPS/TLS aux services distants, chiffre les jetons Shopify stockés dans l’application, applique l’isolation multi-commerçant par RLS dans la base et contrôle les actions selon le rôle de l’utilisateur. Ces mesures ne constituent pas une certification ni une garantie d’absence d’incident.

## 8. Droits et demandes

Le commerçant peut adresser ses demandes relatives à son compte au contact indiqué ci-dessous. Pour les données de ses clients finaux, le commerçant est le point de contact ; Tëër fournit les mécanismes techniques prévus pour l’aider à traiter les demandes, notamment les webhooks de conformité Shopify.

## 9. Gratuité

Le service est gratuit à ce jour. Toute offre payante future sera annoncée avec un préavis raisonnable et ne s’appliquera qu’après acceptation explicite.

## 10. Modifications et contact

La présente politique peut être mise à jour. Les modifications substantielles seront communiquées et, lorsque nécessaire, soumises à une nouvelle acceptation.

Pour toute question relative aux données personnelles : **[[À_FOURNIR : CONTACT_SUPPORT]]**.
Éditeur : **[[À_FOURNIR : ÉDITEUR_NOM]]**, **[[À_FOURNIR : ÉDITEUR_LOCALISATION]]**.
