# Dossier local reviewer Shopify — S2

Ce document prépare la vérification manuelle de Teer Public. Il ne constitue ni une preuve de configuration Partner Dashboard ni une soumission.

## Mode de lancement

- Offre candidate : bêta gratuite.
- Aucun abonnement ou moyen de paiement n'est requis.
- Aucun checkout externe n'est présenté dans le parcours Shopify.
- Les fonctionnalités Pro sont annoncées comme « bientôt » et ne sont pas payantes.
- Shopify Billing est reporté à la Phase 6, avant toute fonctionnalité payante.

## Parcours local constaté

Le code actuel propose encore une connexion depuis Tëër → Boutiques → Connecter Shopify → `/api/shopify/install`. Le domaine `myshopify.com`, le state, le nonce, le callback et le HMAC OAuth sont validés côté serveur.

Ce parcours ne prouve pas l'installation initiée depuis une surface Shopify. Il exige une session Tëër avant l'OAuth et ne fournit pas encore de surface embarquée App Bridge.

## Blocage critique

`shopify.app.toml` indique `embedded = false`. Le dépôt ne contient pas App Bridge, session tokens Shopify ni point d'entrée embarqué. Une correction sûre nécessite une décision d'architecture sur l'authentification de la surface embarquée ; elle est donc classée `BLOCKED — EMBEDDED APP REMEDIATION REQUIRED` dans S2.

## Instructions reviewer à finaliser après déblocage

1. Installer l'application depuis la fiche Shopify.
2. Autoriser l'accès demandé et vérifier le retour dans l'interface.
3. Confirmer l'état de synchronisation d'une boutique synthétique.
4. Ouvrir le cockpit Tëër et consulter Tableau, Commandes et Produits/Stock.
5. Vérifier l'aide/support et la procédure de désinstallation.

Les identifiants de test et les captures finales doivent être fournis séparément, sans secret, PCD, navigateur ou bureau visibles.
