# Rétention Shopify Protected Customer Data

Les durées de ce document sont des décisions produit minimales. Elles ne constituent pas une obligation légale sénégalaise et doivent être validées juridiquement avant toute activation en production.

## Règles appliquées localement

| Catégorie | Déclencheur fiable | Durée | Action |
|---|---|---:|---|
| Adresse de commande | `orders.pcd_finalized_at`, établi à l’entrée dans `delivered`, `failed`, `returned`, `completed` ou `cancelled` | 90 jours | `orders.shipping_address` nullifié et snapshot `delivery_address` de commande supprimé |
| Identité client Shopify | `customer.shopify_last_activity_at`, alimenté uniquement par `orders/create`, `orders/updated`, `orders/cancelled`, `orders/fulfilled` et leurs imports Bulk, avec `updatedAt` Shopify ou `createdAt` Shopify | 12 mois | redaction transactionnelle 0121 puis tombstone renouvelé |
| Payload GDPR retryable | `webhook_event.received_at` | 7 jours | passage terminal, payload nullifié, code `retention_payload_expired` |
| Payload `done`/`terminal` historique | présence anormale d’un payload brut | immédiat | payload nullifié, métadonnées techniques conservées |
| Artefact DSAR | `shopify_dsar_artifact.expires_at` | 24 heures | claim SQL, suppression Storage, puis état `purged` |
| Tombstone | `expires_at` | 12 mois après redaction | suppression seulement après expiration |
| Faits financiers et techniques | identifiants, montants, états, dates, agrégats | hors de ce lot | aucune suppression par S1B-2B |

Une commande finale historique sans transition fiable ne reçoit pas de date artificielle : `pcd_finalized_at` reste `NULL` et la purge est bloquée. Si une commande quitte un état final, le trigger retire l’ancienne date ; une nouvelle entrée finale crée une nouvelle échéance.

La purge d’identité est bloquée par toute commande active, livraison ouverte, retour non clôturé, COD non réconcilié ou provenance boutique absente. Les erreurs sont réduites à des codes contrôlés et des compteurs.

## Dry-run et exécution

`shopify_pcd_retention_candidates()` est l’unique source SQL des critères. `preview_shopify_pcd_retention()` ne retourne que catégorie, compteurs, boutiques concernées, première/dernière échéance et blocages. Aucun nom, téléphone, adresse, payload, contenu DSAR ou identifiant Shopify externe n’est retourné.

L’exécution est bornée à 100 lignes par catégorie et utilise `FOR UPDATE SKIP LOCKED`. Les artefacts DSAR suivent deux phases : claim avec lease, suppression Storage vérifiée, puis finalisation SQL. Une erreur Storage conserve la métadonnée en état retryable avec backoff.

## Déclenchement — activé

La route interne `/api/cron/shopify-pcd-retention` accepte `mode=dry-run` ou `mode=execute`, exige `Authorization: Bearer <CRON_SECRET>`, refuse toute configuration absente et borne la taille des lots (défaut 25, max 100, par catégorie).

**Activée dans `vercel.json` à `0 3 * * *`** (03:00 UTC quotidien, `mode=execute`), après validation par le porteur : volumétrie de production nulle sur les 6 catégories (aucun arriéré), confirmée par la requête de contrôle du Stage 0 ; la séquence progressive de purge manuelle par lots n'a donc pas été nécessaire, seul un dry-run de contrôle a suffi. Horaire choisi 1h après `shopify-reconcile` (02:00) pour ne jamais chevaucher (durée max 300s de reconcile), et à distance de `keep-alive` (06:00, tous les 3 jours). Une exécution quotidienne est le plancher pratique du plan Hobby (crons limités à une exécution par jour, précision ±59 min) et correspond à la fenêtre la plus courte du produit (artefact DSAR, 24 heures) : une cadence quotidienne est donc à la fois le maximum permis par le plan et le minimum utile pour ne pas laisser un artefact DSAR expiré traîner plus d'un jour.

## Limites restantes

- migration `0122` appliquée en production ; route désormais planifiée quotidiennement, preuve de purge de production en régime réel (au-delà du dry-run de contrôle) à observer sur les prochains runs ;
- chiffrement de production, DLP, journalisation générale des lectures PCD et réponse aux incidents restent S1C/S1D ;
- **asymétrie de traçabilité, à corriger avant la soumission Phase 4** : `execute_shopify_pcd_retention` (catégorie `expired_customer_identity`) appelle `redact_shopify_customer_copies` — la même fonction que le webhook `customers/redact` — mais, à la différence de `handleGdprWebhook` (qui écrit `audit_log` avec `action: 'gdpr.customers/redact'`), la boucle de purge automatique n'écrit **aucune ligne `audit_log`**. Seul un compteur agrégé sans identifiant client est conservé dans `shopify_pcd_purge_run`. Deux chemins mènent à la même destruction irréversible de l'identité d'un client ; un seul est tracé nommément. Ne pas corriger au fil de l'eau — traiter comme un lot dédié avant soumission, avec sa propre migration si `audit_log` doit être alimenté depuis `execute_shopify_pcd_retention`.
