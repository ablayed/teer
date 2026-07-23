# Checklist publication app Shopify — Tëër (Phase 7a)

La préparation de publication concerne **Teer Public**. Son statut de distribution réel doit être confirmé dans le Partner Dashboard ; ce document ne le prouve pas.

**Gating de facturation :** un marchand acquis via l'App Store qui accède à des fonctionnalités payantes doit être facturé via Shopify Billing. Un client Tëër effectivement payant avant sa première connexion Shopify peut conserver une facturation externe, à condition de conserver une preuve non modifiable de son paiement antérieur et de l'ordre chronologique. Le modèle détaillé et la décision de Shopify Support font foi dans [phase-0c-shopify-billing.md](./phase-0c-shopify-billing.md).

KOBA reste le connecteur custom du pilote. Une custom app peut rester un parcours accompagné transitoire ; elle n'est pas la voie durable de distribution multi-marchands.

## Exigences techniques (état Phase 7a)

| Exigence | État | Où |
|---|---|---|
| Version API épinglée | ✅ `2026-04` | `shopify.app.toml` `[webhooks] api_version`, `lib/shopify/graphql.ts` `SHOPIFY_API_VERSION` |
| GraphQL Admin API uniquement (pas de REST legacy) | ✅ | `lib/shopify/graphql.ts`, `bulk.ts` |
| Tokens offline **expirants** + refresh proactif | ✅ | `lib/shopify/token.ts` (`getValidShopAccessToken`), `oauth.ts` (`refreshAccessToken`) |
| Tokens **chiffrés au repos** (AES-256-GCM) | ✅ | `lib/shopify/crypto.ts`, clé `SHOPIFY_TOKEN_ENCRYPTION_KEY` |
| Jamais de token en clair en logs | ✅ | vérifié dans token/oauth/sync |
| Multi-boutiques par marchand | ✅ | migration `0037` (retrait `unique(merchant_account_id)`), callback `onConflict: shop_domain` |
| Idempotence webhooks (dédup par `X-Shopify-Webhook-Id`) | ✅ | `webhook_event` (unique) + `recordWebhookReceipt` ; rejeu → 200 sans effet |
| Réponse webhook 200 rapide (< 5 s) | ✅ | HMAC → dédup → 200, traitement métier en `after()` (post-réponse) |
| Garde hors-ordre | ✅ | `isStaleShopifyUpdate` (compare `shopify_updated_at`) |
| Shopify n'écrase jamais l'état opérationnel (4 dimensions) | ✅ | colonnes miroir `shopify_*` distinctes ; update ne touche pas order/call/delivery/cash_state |
| 3 webhooks GDPR **réels** sur PII réelle (7b) | ✅ | `customers/data_request` (compile tout), `customers/redact` (efface nom/prénoms/téléphone/phone_e164/email/adresse/tags/consentement, retrouvé par GID legacy **et** tableau `shopify_customer_gids`), `shop/redact` (clients **exclusifs** à la boutique) → `lib/shopify/gdpr.ts` |
| Désinstallation par boutique (révocation tokens, sync stoppée) | ✅ | `app/uninstalled` → status uninstalled + tokens révoqués (cette boutique seule) |
| Sync deux vitesses (bulk + temps réel) | ✅ | `bulk.ts` + webhooks ; réconciliation nocturne `cron/shopify-reconcile` (02:00) |
| Fallback polling bulk (webhook non garanti) | ✅ | `waitForBulkCompletion` |
| Rate limits 429 → backoff (Retry-After) | ⚠️ partiel | `downloadJsonl` (JSONL) ; les appels GraphQL bulk relèvent encore l'erreur THROTTLED de `shopifyGraphQL` (à durcir si besoin) |
| HMAC vérifié sur tous les webhooks | ✅ | `verifyWebhookHmac` avant tout traitement |

## À faire dans le Dashboard partenaire Shopify (manuel, hors code)

1. Déclarer l'URL des webhooks de conformité (déjà dans `shopify.app.toml` `compliance_topics`) et **tester** les 3 topics GDPR depuis le dashboard.
2. Renseigner **App listing** : nom, description FR, captures, politique de confidentialité (URL `/confidentialite`), URL d'assistance.
3. Demander l'accès aux **données client protégées** (protected customer data) et justifier l'usage COD. Ne déclarer que les champs réellement traités : nom/prénom, téléphone et adresse de livraison. Le téléphone est l'identité principale pour la déduplication et les appels de confirmation ; le nom et l'adresse sont nécessaires à l'exécution de la livraison.
   - Ne pas demander l'e-mail du client final : il n'est pas traité par le code et la migration `0049` a supprimé cette capacité.
   - Ne pas demander le consentement marketing : Tëër ne l'utilise pas pour une finalité marketing.
   - Justifier la **minimisation** : conservation limitée aux données nécessaires à la livraison COD ; effacement réel sur `customers/redact` / `shop/redact` (< 30 j / 48 h).
   - **Blocage avant soumission :** le code d'ingestion lit encore `tags`, `numberOfOrders`, `amountSpent`, `createdAt` et normalise `emailMarketingConsent`. Ces champs ne justifient pas la demande PCD minimale ci-dessus. Leur lecture/stockage devra être retiré ou explicitement justifié dans un chantier ultérieur avant toute demande PCD ; cette phase documentaire ne modifie pas le code.
4. Vérifier que la version API stable courante = `2026-04` sur shopify.dev avant soumission ; sinon ré-épingler.
5. Choisir et confirmer la distribution de Teer Public dans le Partner Dashboard. Toute offre App Store réellement gratuite/bêta ne doit afficher ni déclencher de souscription externe. Avant toute fonctionnalité payante pour un marchand acquis via l'App Store, Shopify Billing devra être implémenté en Phase 7.
6. Variables d'env prod (Vercel) : `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_TOKEN_ENCRYPTION_KEY` (64 hex), `CRON_SECRET`. **Multi-app** : pour une app pilote custom (KOBA), ajouter ses variables dédiées en Prod + Preview sans toucher aux clés de Teer Public ; elles doivent être présentes par paire sinon l'app est ignorée au boot. Routage par `client_id` → `shop.shopify_client_id` (cf. CLAUDE.md « Shopify multi-app »).

## Restes connus (non bloquants pour 7a, à traiter en 7b/7c)

- Backoff THROTTLED sur les mutations/queries bulk (durcissement).
- `refunds/create` : enregistré (audit) sans dériver plein/partiel — le statut financier vient du `orders/updated` jumeau.
- ✅ Enrichissement client (7b) fait : import PII enrichie + dédup téléphone E.164 + GDPR réel. Reste : analytics annulations/retours (7c).
