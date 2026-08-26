# Runbook de bascule — abonnements webhook Shopify vers l'URL opaque (L3)

> Document opérationnel. Ne remplace pas `CLAUDE.md` (source de vérité) — décrit la séquence
> exacte de bascule des abonnements Shopify réels vers l'endpoint à URL opaque
> (`app/api/shopify/ingest/[token]/route.ts`, migration `0143`), et la fermeture en deux temps
> de l'exception de sécurité de Phase 1 (identité par en-tête non signé sur l'ancien endpoint).
>
> Outil : `scripts/webhook-subscription-migration.mjs` (`--plan` / `--apply` / `--rotate-token`).
> Voir son en-tête pour l'invariant d'idempotence et le détail des trois modes.

---

## Verrou 0 — prérequis BLOQUANT, non résolu par ce document

**Le nouvel endpoint n'écrit PAS encore les tables métier.** Vérifié par lecture directe de
`app/api/shopify/ingest/[token]/route.ts` (`processIngestedEvent`) : il appelle
`writeOrderIngestion`/`writeProductIngestion`/`writeRefundIngestion`/`writeBulkOperationIngestion`
— ces fonctions alimentent le registre canonique L1/L2 (`ingestion_event`/`external_ref`), **pas**
`orders`/`product`. Les seules fonctions qui écrivent réellement ces tables
(`persistShopifyOrder`, `persistShopifyProductWebhook`, le traitement `refunds/create` complet,
`processFinishedBulkForShop`) restent exclusivement câblées sur l'ancien endpoint
(`app/api/shopify/webhooks/route.ts`).

**Conséquence si ce verrou est ignoré :** basculer les abonnements réels vers le nouvel endpoint
sans cette parité arrêterait la synchronisation Shopify → `orders`/`product` en production, alors
que côté Shopify tout semblerait fonctionner (200 sur chaque livraison). Ce n'est pas une
dégradation visible — c'est un arrêt silencieux de la source de vérité commande/produit.

**Ce runbook ne s'exécute pas tant que ce câblage n'est pas livré, testé, et confirmé en revue**
— un lot séparé, non entamé ici. Documenté dans le rapport de session de Lot L3 comme prérequis
du « lot de bascule » ; ce document en est la confirmation formelle avant exécution.

---

## Prérequis fondateur — sous-domaine dédié (bloquant pour Étape 1 seulement)

Un sous-domaine dédié et stable doit exister avant toute mutation d'abonnement réel :

- dédié aux webhooks, jamais partagé avec des routes web ordinaires ;
- ni `teer-dev.vercel.app`, ni URL de preview, ni domaine produit partagé ;
- rattaché au projet Vercel de production, TLS et alias de production vérifiés ;
- exposé par `WEBHOOK_PUBLIC_BASE_URL` (production uniquement), HTTPS, sans slash final —
  l'outil refuse de démarrer sans elle (cf. `scripts/webhook-subscription-migration.mjs`).

---

## Faits établis — documentation Shopify, pas supposition

Sources : `shopify.dev/changelog/updates-to-webhook-retry-mechanism` (effectif 2024-09-10) et la
page « best practices » des webhooks Shopify.

1. **Retry** : 8 tentatives sur 4 heures, backoff exponentiel. Shopify ne documente PAS les
   intervalles exacts du backoff, ni ce qui se passe après le 8ᵉ échec (abandon silencieux,
   suppression de l'abonnement — non trouvé, non affirmé).
2. **Fait décisif** : *« Retried webhooks are delivered with original payloads to the subscription
   address active when triggered… updating subscription addresses during retry cycles will not
   redirect webhooks to new endpoints. »* — l'adresse est liée au **moment du déclenchement**,
   pas à chaque tentative. Un événement déclenché avant une bascule reste lié à l'ancienne
   adresse pour tout son cycle de vie (y compris ses réessais) ; un événement déclenché après reste
   lié à la nouvelle. Aucun événement ne peut donc voir les deux adresses (pas de doublon
   structurel), ni aucune (pas de perte structurelle) — **à condition que la mutation soit
   `webhookSubscriptionUpdate` sur l'identifiant existant, jamais un `delete` puis `create`**. Le
   même principe joue en sens inverse pour un rollback (cf. Étape 1, retour arrière) : re-basculer
   ne redirige pas un événement déjà déclenché pendant la fenêtre où l'adresse était la nouvelle.
3. **Pas de garantie de livraison** : *« Webhook delivery isn't always guaranteed »* (best
   practices) — Shopify ne promet ni exactement-une-fois ni livraison garantie, et recommande un
   job de réconciliation comme mitigation.

## Fait établi — le job de réconciliation existant, son périmètre réel

**Correction d'un constat provisoire du rapport de session précédent** : `app/api/cron/shopify-reconcile`
existe (vérifié par lecture, pas supposé absent). Planifié quotidiennement à 02:00 UTC
(`"schedule": "0 2 * * *"`, config Vercel). Pour chaque boutique Shopify active, il appelle
`reconcileShopOrders` → démarre une **bulk query Admin API** `orders(query: "updated_at:>='<last_reconciled_at>'")`
directement contre Shopify (source de vérité), puis persiste via `persistShopifyOrder`, upsert par
`(shop_id, shopify_order_id)` — idempotent.

- **Rattrape-t-il une commande jamais reçue ?** Oui. La requête bulk est un pull direct depuis
  Shopify, filtré uniquement par `updated_at`, **indépendant de ce qui existe déjà dans `orders`**
  — un `upsert` insère une ligne pour toute commande modifiée dans la fenêtre, qu'un webhook l'ait
  ou non jamais délivrée. Au tout premier passage pour une boutique (`last_reconciled_at` nul), le
  filtre est omis entièrement → rattrapage complet, sans fenêtre.
- **Fréquence** : une fois par jour → borne de détection au pire cas ≈ 24h après un événement
  définitivement perdu côté livraison webhook (les 4h de réessai Shopify épuisées **et** notre
  identité ayant refusé l'événement).
- **Périmètre réel, vérifié par lecture de `buildBulkOrdersQuery`** (aucun champ transaction/refund,
  aucun objet produit interrogé) et par recherche exhaustive (`grep -rl reconcile`, deux fichiers
  seulement dans tout le dépôt) : **`orders/*` uniquement**. Aucune réconciliation n'existe pour
  `products/*` ni `refunds/create` ni `bulk_operations/finish`. `app/uninstalled` n'entre pas dans
  cette classe de risque — c'est une transition de statut, pas une donnée à rattraper, et l'accès
  Admin API lui-même est révoqué à la désinstallation (rien à repull de toute façon).

**Conclusion, sans sur-affirmer ni minimiser** : pour `orders/*`, le risque de perte permanente
nommé plus bas est **atténué**, borné à 24h de détection au pire cas — pas éliminé (la
réconciliation ne fait rien pour un événement perdu qui ne modifie plus jamais `updated_at`, cas
en pratique marginal). Pour `products/*`, `refunds/create` et `bulk_operations/finish`, **aucune
mitigation n'existe** — le risque de perte silencieuse au-delà de la fenêtre de réessai Shopify
(4h) reste entier pour ces trois topics.

---

## Fermeture en deux temps — pas une seule bascule

**L'ancien endpoint ne meurt jamais** : il continue de servir les trois topics de conformité GDPR
(`customers/data_request`, `customers/redact`, `shop/redact`), non souscriptibles via l'Admin API,
pour toujours. « Plus aucun topic opérationnel actif ne cible l'ancien endpoint » se vérifie donc
côté abonnements Shopify (Étape 1) — mais le **code** de résolution par en-tête
(`resolveSignedShopDomain`, `app/api/shopify/webhooks/route.ts`) doit rester vivant pour les 9
topics opérationnels le temps d'absorber les réessais en vol au moment du swap, puis être
explicitement désactivé pour ces 9 topics seulement.

| Temps | Action | Critère de vérification | Retour arrière |
|---|---|---|---|
| **1 — Jour J** | `--apply`/`--rotate-token` bascule les 9 abonnements Admin-API vers l'URL opaque. Le chemin en-tête de l'ancien endpoint reste **actif** pour les 9 topics opérationnels (code inchangé). | (a) Relecture intégrée à l'outil (`verifyAndCleanup`) : exactement 1 abonnement par topic, pointant vers le jeton courant — déjà automatique. (b) Confirmation manuelle qu'au moins une livraison réelle arrive dans `ingestion_event` pour la boutique pilote, sur au moins un topic à fort volume (`orders/updated` typiquement). | `webhookSubscriptionUpdate` inverse (nouvelle → ancienne URL) via le même outil ou manuellement. **Ne redirige PAS** les événements déjà déclenchés pendant que la nouvelle adresse était active (fait établi #2 ci-dessus, symétrique) — ceux-ci continuent leur cycle de réessai (jusqu'à 4h) contre le nouvel endpoint : le nouvel endpoint doit donc rester joignable (même dégradé) au moins 4h après un rollback, pas être coupé net. |
| **2 — J + marge** | Le code de `app/api/shopify/webhooks/route.ts` **refuse** les 9 topics opérationnels (401, même verdict indifférencié que le nouvel endpoint) — garde explicite par topic, pas une suppression de code. Les 3 topics GDPR restent servis **sans aucun changement**, indéfiniment. | Requête en lecture seule contre `webhook_event` : **zéro** ligne dont `topic` ∈ {9 topics opérationnels} et `received_at` postérieur à l'instant du swap Étape 1, sur toute la durée de la marge retenue — mesuré, pas supposé (cf. section suivante). | Retirer la garde de refus (revert du commit/feature flag) — sans risque : elle ne fait que rouvrir un chemin que plus rien n'utilise activement au moment où on la retire (le critère de vérification l'a confirmé avant d'agir). |

**L'exception de sécurité de Phase 1 n'est fermée qu'à l'issue du Temps 2, jamais au Jour J.**
C'est **cette** date — celle où le refus opérationnel sur l'ancien endpoint est en place et
vérifié — qui doit être consignée dans `CLAUDE.md`, pas la date de la bascule des abonnements.

**Le critère du Temps 2 n'est valable que si `webhook_event` est écrit EXCLUSIVEMENT par l'ancien
endpoint — vérifié, pas supposé.** Une requête qui compte des livraisons dans une table alimentée
par les deux endpoints, sans marqueur pour les distinguer, serait inopérante sans que rien ne le
signale. Recherche exhaustive (`grep -rn ".from('webhook_event')" app/ lib/ scripts/`, hors
tests) : **deux occurrences, toutes deux dans `app/api/shopify/webhooks/route.ts`** (l'ancien
endpoint), aucune ailleurs. Le nouvel endpoint (`app/api/shopify/ingest/[token]/route.ts`) écrit
exclusivement dans `ingestion_event` — via `writeIngestionEvent`
(`lib/ingestion/dual-write.ts`/`lib/ingestion/shopify-dual-write.ts`), qui ne touche jamais
`webhook_event` (confirmé par lecture de ces deux fichiers, aucune occurrence). Les deux tables
sont donc séparées par construction, une par endpoint — le critère SQL du Temps 2 est bien
opérant tel qu'écrit, sans correctif préalable. Si un jour un chemin venait à écrire dans
`webhook_event` depuis le nouvel endpoint (ou l'inverse), cette séparation devrait être
re-vérifiée avant de refaire confiance à ce critère — ne pas la présumer strictement permanente.

---

## La marge résiduelle — bornée, puis arbitraire, dit comme tel

**Borne établie par la documentation** : 4 heures (8 tentatives, backoff exponentiel — le seul
chiffre que Shopify publie). C'est un plafond documenté, pas un minimum garanti : Shopify ne dit
pas si un cas réel peut légèrement le dépasser (jitter réseau, files internes Shopify).

**Marge retenue : 24 heures — explicitement arbitraire, pas déduite d'une source Shopify au-delà
du chiffre de 4h lui-même.** Raisonnement : maintenir le chemin en-tête vivant plus longtemps que
nécessaire ne coûte rien (le code existe déjà, ne sert qu'aux 9 topics opérationnels le temps de
la fenêtre, et le retirer est une opération triviale et réversible) — alors que le couper trop tôt
risquerait de refuser un réessai tardif et légitime. 24h est un multiple rond (×6 de la borne
documentée) choisi pour ce confort, rien de plus précis. Si un futur porteur veut resserrer ce
chiffre, il doit le dire explicitement plutôt que le traiter comme une valeur Shopify — ce n'en est
pas une.

**Critère observable de fenêtre écoulée, à exécuter avant de passer au Temps 2 :**

```sql
select topic, count(*), max(received_at) as derniere_livraison
from public.webhook_event
where topic in (
  'orders/create', 'orders/updated', 'orders/cancelled', 'orders/fulfilled',
  'products/create', 'products/update', 'refunds/create',
  'bulk_operations/finish', 'app/uninstalled'
)
and received_at > '<instant exact du swap Étape 1, UTC>'
group by topic
order by topic;
```

**Règle** : si cette requête renvoie **zéro ligne**, la marge est écoulée pour de vrai — passer au
Temps 2. Si une ligne existe, un réessai tardif est encore arrivé sur l'ancien endpoint : ne pas
couper, attendre au moins jusqu'à `derniere_livraison + marge`, puis ré-exécuter la même requête.
Ne jamais avancer au Temps 2 sur une estimation de temps écoulé seule — cette requête est
l'unique preuve valable, exactement comme les préflights de production des lots précédents
(`CLAUDE.md`, règle projet #4 : jamais présumer l'état réel, toujours le lire).

---

## Séquence complète

0. Confirmer le Verrou 0 (parité d'écriture métier du nouvel endpoint) — **STOP si non résolu**.
1. Confirmer le sous-domaine dédié et `WEBHOOK_PUBLIC_BASE_URL`.
2. `node scripts/webhook-subscription-migration.mjs --plan` — relu par le fondateur avant tout
   `--apply`. Aucun jeton n'est généré à cette étape.
3. `--apply` (première bascule, connexions sans jeton local — `'provision'`) ou `--rotate-token
   <connexion>` (connexions ayant déjà un jeton local — cas attendu si un test antérieur a
   provisionné un jeton), boutique par boutique.
4. **Temps 1 — vérification** : relecture automatique de l'outil + confirmation manuelle d'au
   moins une livraison réelle observée dans `ingestion_event` sur la boutique pilote.
5. **Temps 1 — enregistrer l'instant exact du swap** (UTC), nécessaire à la requête du Temps 2.
6. Attendre la marge retenue (24h, cf. ci-dessus).
7. **Temps 2 — vérification** : exécuter la requête `webhook_event` ci-dessus. Zéro ligne → passer
   à l'étape 8. Sinon → attendre, ré-exécuter, ne pas avancer.
8. **Temps 2 — action** : livrer la garde de refus des 9 topics opérationnels sur l'ancien
   endpoint (lot de code séparé, hors de ce document — un `revoke`-équivalent au niveau routage,
   jamais une suppression du code GDPR).
9. Consigner dans `CLAUDE.md` : la fermeture de l'exception de sécurité de Phase 1, **datée de
   l'étape 8**, avec l'inventaire réel des abonnements post-bascule et un pointeur vers ce
   document.

---

## Hors périmètre de ce runbook

Câblage des écritures métier complètes sur le nouvel endpoint (Verrou 0 — lot séparé) · preuve de
sortie de Phase 2 (import/déduplication/rejeu/isolation sur la boutique pilote — Étape 4 du
prompt de clôture, document séparé une fois ce runbook exécuté) · inversion des 2 PIN L0 sur
l'ancien comportement d'en-tête (dépend de l'étape 8, pas de l'étape 1).
