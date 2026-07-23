# Phase 0C — Finalisation du dossier Shopify

## DÉCISION — Réponse Shopify sur l'exemption Billing API

Shopify Support (Rob P., 23 juillet 2026) a confirmé par écrit, avant
soumission, que le modèle de Tëër ne remplit pas les critères
d'exemption de la Billing API. Traité comme décisif pour la
planification, sans prétendre qu'une revue d'app formelle a eu lieu
(les exemptions sont évaluées pendant la revue elle-même ; Rob a
donné cette réponse en amont pour éviter une soumission vouée à
l'échec).

Règle confirmée :
- Tout marchand acquis via l'App Store Shopify et accédant à des
  fonctionnalités payantes doit être facturé via Shopify Billing.
- Un marchand qui était déjà client Tëër effectivement payant AVANT
  sa première connexion Shopify conserve sa facturation externe
  (Wave/Orange Money/PayDunya, XOF).
- Aucune des portes de repli envisagées ne qualifie pour une
  exemption : visibilité limitée, abonnement couvrant aussi des
  boutiques non-Shopify, multi-plateforme, système de facturation
  propre existant.

Archive le texte intégral de la réponse de Rob comme preuve liée à
Teer Public / App ID.

## DÉCISION — Modèle de facturation par compte

L'ancienne règle "billing_provider déterminé par source_platform"
est incorrecte et doit être remplacée partout où elle apparaît
(documentation, schéma envisagé, roadmap) par un modèle basé sur
l'historique du compte, pas sur la plateforme connectée :

```text
merchant_account
└── subscription
    ├── billing_provider          (external_xof | shopify)
    ├── billing_eligibility_basis (preexisting_paid_customer |
    │                               shopify_app_store_acquisition |
    │                               non_shopify_customer)
    ├── first_paid_at
    ├── shopify_first_connected_at
    ├── acquisition_channel
    └── external_payment_reference
```

L'éligibilité à la facturation externe doit être prouvée par un
abonnement effectivement payé (référence de transaction
Wave/PayDunya/Bictorys) antérieur à la première connexion Shopify,
pas seulement par une date modifiable.

L'unité facturable reste merchant_account, jamais shop_id. Un compte
acquis via l'App Store voit son abonnement global (toutes boutiques
confondues) facturé par Shopify. Un compte Tëër préexistant et payant
reste facturé en externe même s'il connecte ensuite Shopify.

## DÉCISION — Parcours d'onboarding Wave → connexion Shopify immédiate
(risque assumé)

Ablaye a explicitement accepté le risque suivant (23 juillet 2026) :
le parcours "création compte Tëër → paiement Wave/OM → clic Connecter
Shopify" reste immédiat, sans délai ni signal d'usage minimal imposé
entre le paiement et la connexion.

Risque connu et assumé : Shopify n'a pas confirmé par écrit que ce
parcours qualifie sans ambiguïté comme "client préexistant payant"
au sens de sa réponse du 23 juillet 2026. Un reviewer pourrait le
considérer comme un contournement de Shopify Billing lors de la
soumission de Teer Public.

Mitigation minimale obligatoire : conserver systématiquement la
preuve non modifiable de l'ordre chronologique réel (date/heure du
paiement Wave réussi, référence de transaction, date/heure de la
première connexion Shopify) pour chaque compte, même si le parcours
UI ne l'impose pas. Cette preuve doit exister avant la soumission de
l'app, pas être reconstruite après coup.

Ce point devra être réévalué explicitement au moment de préparer le
dossier de soumission Teer Public — accepter le risque en phase de
conception n'implique pas de le garder sans relecture au moment de
soumettre réellement l'app à Shopify.

Propriétaire : Ablaye.

## Références historiques à conserver

La migration `0048_multi_app_shop_client_id.sql` décrit Teer Dev comme app publique au moment où elle a été écrite. C'est une trace historique append-only : elle ne doit pas être réécrite. La décision actuelle de distribution et de facturation est celle de ce document ; toute correction de comportement relève d'une phase ultérieure, sans modifier la migration historique.
