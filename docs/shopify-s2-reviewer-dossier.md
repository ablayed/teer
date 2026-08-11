# Dossier local reviewer Shopify — S2

Ce document prépare la vérification manuelle de Teer Public. Il ne constitue ni une preuve de configuration Partner Dashboard ni une soumission.

## Mode de lancement

- Offre candidate : bêta gratuite.
- Aucun abonnement ou moyen de paiement n'est requis.
- Aucun checkout externe n'est présenté dans le parcours Shopify.
- Les fonctionnalités Pro sont annoncées comme « bientôt » et ne sont pas payantes.
- Shopify Billing est reporté à la Phase 6, avant toute fonctionnalité payante.

## Parcours local constaté

Le parcours reviewer commence exclusivement dans Shopify Admin, sur la surface embarquée
`/shopify/embedded`. L'installation et l'autorisation Shopify passent par le flux OAuth existant ;
le state, le nonce, le callback et le HMAC sont validés côté serveur. Après l'arrivée dans la
surface, App Bridge fournit un session token vérifié côté serveur avant toute lecture de boutique.

L'association à Tëër reste explicite : une boutique peut d'abord être affichée comme
`not configured`, puis le marchand choisit l'association avec son compte Tëër. Le bouton public
Tëër ne demande plus de domaine `myshopify.com` et ne lance pas une installation.

## Surface embarquée livrée localement

L’entrée Shopify est `/shopify/embedded`. Elle affiche uniquement l’identité publique de la
boutique, l’état d’installation, l’état ou la date de dernière synchronisation, la prochaine
action, le lien volontaire vers le cockpit complet, le support et les instructions de
désinstallation/suppression. Elle n’embarque pas le cockpit et ne demande pas de domaine
`myshopify.com` depuis Tëër.

App Bridge est chargé avant la surface applicative. Les appels backend portent un session token
Shopify vérifié côté serveur ; aucun token Admin API, secret ou cookie tiers ne passe dans le
navigateur, l’URL ou les logs. L’association à Tëër reste une action explicite après confirmation
de l’installation Shopify ; elle ne crée pas silencieusement d’utilisateur ni de rôle owner.

`shopify.app.toml` indique désormais `embedded = true` et pointe vers `/shopify/embedded`. La
surface, la route de session token, l’installation depuis Shopify et les tests synthétiques sont
versionnés localement. La configuration distante Partner Dashboard reste à appliquer en S3.

Les jetons offline expirables utilisent les colonnes existantes chiffrées
`access_token_encrypted`, `refresh_token_encrypted`, `access_token_expires_at` et
`refresh_token_expires_at`. Le refresh est synthétique en local, protégé contre une rotation
concurrente par boutique et invalidé fonctionnellement après désinstallation ; aucun token réel
n’est migré ou révoqué.

## Gate UX reviewer

Les fixtures visuelles doivent atteindre une page métier authentifiée ou échouer explicitement si
`/connexion` reste visible. Les snapshots ne sont jamais régénérés en masse. Chaque différence
est classée `HARNESS/AUTH FIXTURE`, `SNAPSHOT OBSOLETE`, `PLATFORM-SPECIFIC BASELINE`, `REAL UX
DEFECT` ou `NOT TESTABLE LOCALLY` avant toute correction.

Backlog non-P0 après ce lot : `P1` cycle COD critique, `P2` mobile/compréhension, `P3` finition
visuelle.

1. Installer l'application depuis la fiche Shopify.
2. Autoriser l'accès demandé et vérifier le retour dans l'interface.
3. Confirmer l'état de synchronisation d'une boutique synthétique.
4. Ouvrir le cockpit Tëër et consulter Tableau, Commandes et Produits/Stock.
5. Vérifier l'aide/support et la procédure de désinstallation.

Les identifiants de test et les captures finales doivent être fournis séparément, sans secret, PCD, navigateur ou bureau visibles.
