# Checklist publication app Shopify — Tëër (Phase 7a)

App **publique en visibilité limitée (unlisted)**, PAS custom. Passe la review Shopify.
Pas besoin de finir la Phase 8 (IA) pour publier.

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
3. Demander l'accès aux **données client protégées** (protected customer data) et justifier l'usage (opérations COD). Champs à déclarer :
   - **Niveau 1** (protected customer data) : `name`/`firstName`/`lastName`, `defaultAddress`/`shippingAddress`, `tags`, `numberOfOrders`, `amountSpent`, `createdAt` — affichés sur la fiche client pour la livraison COD et l'historique.
   - **Niveau 2** (protected customer fields) : `email`, `phone`, `emailMarketingConsent` — **téléphone = identité principale** (dédup + appels de confirmation + WhatsApp), email = clé de dédup secondaire, consentement marketing affiché.
   - Justifier la **minimisation** : on ne stocke que le nécessaire à la livraison (nom, téléphone, adresse, email, consentement) ; effacement réel sur `customers/redact` / `shop/redact` (< 30 j / 48 h).
4. Vérifier que la version API stable courante = `2026-04` sur shopify.dev avant soumission ; sinon ré-épingler.
5. Configurer l'app comme **public unlisted** (pas custom).
6. Variables d'env prod (Vercel) : `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_TOKEN_ENCRYPTION_KEY` (64 hex), `CRON_SECRET`. **Multi-app** : pour une 2e app (Teer Pilote, custom), ajouter `SHOPIFY_PILOTE_API_KEY` + `SHOPIFY_PILOTE_API_SECRET` (Prod + Preview) sans toucher aux clés Teer Dev ; les deux doivent être présentes sinon l'app Pilote est ignorée (warning au boot). Routage par `client_id` → `shop.shopify_client_id` (cf. CLAUDE.md « Shopify multi-app »).

## Restes connus (non bloquants pour 7a, à traiter en 7b/7c)

- Backoff THROTTLED sur les mutations/queries bulk (durcissement).
- `refunds/create` : enregistré (audit) sans dériver plein/partiel — le statut financier vient du `orders/updated` jumeau.
- ✅ Enrichissement client (7b) fait : import PII enrichie + dédup téléphone E.164 + GDPR réel. Reste : analytics annulations/retours (7c).
