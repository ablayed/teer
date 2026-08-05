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
| Idempotence et rejeu des webhooks | ⚠️ code local | `webhook_event` (unique) + états `processing/retryable/terminal/done`, lease, `claim_shopify_webhook_events` (`0121`) ; la migration n'est pas appliquée en production |
| Réponse webhook 200 rapide (< 5 s) | ✅ | HMAC → dédup → 200, traitement métier en `after()` (post-réponse) |
| Garde hors-ordre | ✅ | `isStaleShopifyUpdate` (compare `shopify_updated_at`) |
| Shopify n'écrase jamais l'état opérationnel (4 dimensions) | ✅ | colonnes miroir `shopify_*` distinctes ; update ne touche pas order/call/delivery/cash_state |
| 3 webhooks GDPR avec redaction transactionnelle | ⚠️ code local | `0121.redact_shopify_customer_copies` couvre `customer`, `orders.shipping_address`, notes/attributs libres et `delivery_address` ; stratégie conservatrice globale si la provenance boutique est indissociable ; preuve de production à établir après migration |
| Anti-réimport après redaction | ⚠️ code local | Tombstones uniques `(merchant_account_id, shop_id, shopify_customer_id)`, expiration 12 mois, consultation avant sync normale/Bulk ; purge des tombstones expirés par 0122 non activée à distance |
| Rétention temporelle PCD | ⚠️ code local | 90 jours adresses après transition finale certaine, 12 mois identité après activité Shopify certaine, 7 jours payloads retryable ; preview SQL commun et purge bornée dans 0122 |
| DSAR privé et borné | ⚠️ code local | Bucket Storage privé `shopify-dsar`, métadonnées sans PCD, contrôle serveur owner/manager et URL signée limitée à l'expiration avec maximum 24 h ; claim/suppression Storage/finalisation 0122 non activés à distance |
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
   - Justifier la **minimisation** : conservation limitée aux données nécessaires à la livraison COD. S1B-2A couvre la redaction transactionnelle et les tombstones anti-réimport de 12 mois. S1B-2B encode localement les durées produit : adresses 90 jours après finalisation certaine, identité 12 mois après activité Shopify certaine, payloads retryable 7 jours et DSAR 24 heures ; aucune preuve de production n'est établie.
   - **S1A/S1B-2B appliqués localement :** l'ingestion normale, bulk et webhook ne demande ni ne stocke `tags`, `numberOfOrders`, `amountSpent`, le `createdAt` du client Shopify ou le consentement marketing. Les données conservées sont le nom/prénom, le téléphone, l'adresse et les identifiants techniques Shopify strictement nécessaires ; `orders.shipping_address` reste une copie opérationnelle pour la livraison. Les durées de rétention et la route sont codées et testées localement, mais leur activation quotidienne et leur preuve de production restent à établir ; le chiffrement de production, la DLP, la journalisation générale des lectures PCD, les sauvegardes et la réponse aux incidents restent S1C/S1D.
4. Vérifier que la version API stable courante = `2026-04` sur shopify.dev avant soumission ; sinon ré-épingler.
5. Choisir et confirmer la distribution de Teer Public dans le Partner Dashboard. Toute offre App Store réellement gratuite/bêta ne doit afficher ni déclencher de souscription externe. Avant toute fonctionnalité payante pour un marchand acquis via l'App Store, Shopify Billing devra être implémenté en Phase 7.
6. Variables d'env prod (Vercel) : `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_TOKEN_ENCRYPTION_KEY` (64 hex), `CRON_SECRET`. **Multi-app** : pour une app pilote custom (KOBA), ajouter ses variables dédiées en Prod + Preview sans toucher aux clés de Teer Public ; elles doivent être présentes par paire sinon l'app est ignorée au boot. Routage par `client_id` → `shop.shopify_client_id` (cf. CLAUDE.md « Shopify multi-app »).

## Restes connus (non bloquants pour 7a, à traiter en 7b/7c)

- Backoff THROTTLED sur les mutations/queries bulk (durcissement).
- S1B-2B : la migration 0122 et la route de purge sont préparées localement ; aucune activation quotidienne distante, aucun cron Vercel/Supabase et aucune preuve de purge de production ne sont établis.
- `refunds/create` : enregistré (audit) sans dériver plein/partiel — le statut financier vient du `orders/updated` jumeau.
- ✅ Enrichissement client (7b) fait : import PII enrichie + dédup téléphone E.164 + GDPR réel. Reste : analytics annulations/retours (7c).
