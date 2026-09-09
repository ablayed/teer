# Configuration Shopify de l'app « Teer Public » — déploiement et vérification

Fichier de configuration : `shopify.app.teer-public.toml` (racine du dépôt).
Version active au moment de la rédaction : **`teer-public-2`**.

Ce document décrit **une publication qui ne remplace rien tant que le porteur ne l'a pas
décidé**. L'agent ne l'exécute pas : `shopify app deploy` exige une authentification interactive
au Partner Dashboard.

---

## 1. Ce qui est déclaré, et pourquoi ce partage

**Quatre abonnements au niveau app**, tous sur l'endpoint historique
`https://www.teerafrik.com/api/shopify/webhooks` :

| Topic | Pourquoi au niveau app |
|---|---|
| `customers/data_request` | **Incapacité.** Absents de l'énumération `WebhookSubscriptionTopic` |
| `customers/redact` | de l'Admin API : `webhookSubscriptionCreate` ne peut pas les créer. |
| `shop/redact` | Le TOML est le seul endroit où ils peuvent exister. |
| `app/uninstalled` | **Décision.** Il est parfaitement souscriptible par l'Admin API — voir §2. |

**Huit abonnements métier par boutique**, créés sur l'URL opaque pendant la bascule
(`scripts/webhook-subscription-migration.mjs --apply`, étape 11 du runbook Option D) :
`orders/create`, `orders/updated`, `orders/cancelled`, `orders/fulfilled`, `products/create`,
`products/update`, `refunds/create`, `bulk_operations/finish`.

Ils ne sont **jamais** déclarés dans le TOML.

## 2. Pourquoi `app/uninstalled` reste au niveau app — le fait qui a tranché

Établi depuis la documentation officielle, pas supposé. La query
[`webhookSubscriptions`](https://shopify.dev/docs/api/admin-graphql/latest/queries/webhookSubscriptions)
de l'Admin GraphQL est décrite ainsi :

> « Retrieves a paginated list of webhook subscriptions created using the API for the current app
> and shop. »

avec la note explicite :

> « Returns only shop-scoped subscriptions, **not app-scoped subscriptions configured in TOML
> files**. »

Conséquence directe : un abonnement déclaré dans ce TOML est **structurellement invisible** à
`listSubscriptions` — donc au `--plan`, au `--apply` et à `verifyAndCleanup` de
`scripts/webhook-subscription-migration.mjs`.

Si `app/uninstalled` restait dans `ADMIN_API_TOPICS`, l'étape 11 de la bascule en créerait un
**second**, shop-scoped, vers l'URL opaque. L'outil ne verrait jamais le premier, et ne pourrait
pas le retirer même s'il le voyait (un abonnement app-scoped ne se supprime pas par l'Admin API).
Résultat : **double livraison de `app/uninstalled`**, sur les deux endpoints, invisible à
l'outillage.

D'où le partage 4 / 8, verrouillé par `tests/unit/shopify/teer-public-app-config.test.ts`.

Le garder au niveau app a un second effet, voulu : **le parcours désinstallation → libération
d'identité fonctionne dès aujourd'hui**, sans attendre `WEBHOOK_PUBLIC_BASE_URL`. Son corps porte
une identité boutique signée, il reste donc couvert par `resolveSignedShopDomain` sur l'endpoint
historique — aucune régression de sécurité.

---

## 3. Déploiement — procédure du porteur

> ⚠️ **Ne jamais lancer `shopify app deploy` nu.** Sans `--no-release`, la version créée est
> **publiée immédiatement** et remplace `teer-public-2` sur toutes les boutiques installées.

### Commande exacte

```bash
pnpm exec shopify app deploy --config teer-public --no-release
```

- `--config teer-public` sélectionne `shopify.app.teer-public.toml` (le CLI ajoute lui-même le
  préfixe `shopify.app.` et le suffixe `.toml`). **Ne pas laisser le CLI retomber sur
  `shopify.app.toml`**, qui est **Teer Dev** — une autre app.
- `--no-release` crée la version **sans la publier**. C'est la garantie anti-activation
  accidentelle.

Le CLI demandera une authentification navigateur au Partner Dashboard, puis confirmera l'app
ciblée.

### Ce que le porteur doit vérifier dans le résumé, AVANT de confirmer

Refuser et interrompre si l'un de ces cinq points ne correspond pas :

1. **L'app ciblée est bien « Teer Public »**, `client_id` `86c612a670ee04fe488426f442037605` —
   jamais Teer Dev, Pilote, Marchand ou Koba.
2. **Les portées sont inchangées** : `read_customers,read_orders,read_products`. Toute portée
   ajoutée ou retirée déclencherait un **prompt de reconsentement chez le marchand** et une
   régression sur la boutique déjà rattachée. C'est le point le plus dangereux du lot.
3. **`application_url`** = `https://www.teerafrik.com/shopify/embedded/teer-public`, et
   **`redirect_urls`** = `https://www.teerafrik.com/api/shopify/callback`. Aucun domaine
   `*.vercel.app`, aucun `localhost`.
4. **Quatre abonnements**, tous vers `https://www.teerafrik.com/api/shopify/webhooks` : les trois
   topics de conformité, plus `app/uninstalled`. **Aucun topic métier** (`orders/*`,
   `products/*`, `refunds/create`, `bulk_operations/finish`) ne doit apparaître.
5. **La version n'est PAS publiée** — le CLI doit annoncer une version créée sans release. S'il
   annonce une publication, `--no-release` a été perdu : interrompre.

### Publication, après relecture

Depuis le Dev Dashboard de Teer Public → **Versions** → sélectionner la version créée → comparer
le diff avec `teer-public-2` → **Release**.

### Retour arrière

Aucune migration de données n'est en jeu : une configuration d'app est versionnée côté Shopify.

- **Avant publication** : ne rien faire. Une version non publiée n'a aucun effet ; elle peut
  rester en place indéfiniment.
- **Après publication** : Dev Dashboard → **Versions** → sélectionner **`teer-public-2`** →
  **Release** à nouveau. La configuration précédente redevient active, abonnements au niveau app
  compris.
- Ne jamais « corriger » une version publiée en éditant les abonnements à la main dans le
  Dashboard : la version suivante déployée depuis le TOML les écraserait sans prévenir.

---

## 4. Vérification finale — lecture seule, par le porteur

À faire **après** la publication.

### Les quatre abonnements au niveau app

Ils ne sont **pas** interrogeables par l'Admin API (c'est tout le sujet du §2). La seule preuve
possible est la lecture de la configuration de la version publiée :

Dev Dashboard → Teer Public → **Versions** → la version publiée → section **Webhook
subscriptions**.

À observer, exactement :

- **quatre** entrées, pas trois, pas douze ;
- `customers/data_request`, `customers/redact`, `shop/redact`, `app/uninstalled` ;
- toutes avec l'URI `https://www.teerafrik.com/api/shopify/webhooks` ;
- aucune entrée `orders/*`, `products/*`, `refunds/create`, `bulk_operations/finish`.

### Contre-preuve utile : l'Admin API doit être vide de ces topics

Sur une boutique de test où Teer Public est installée, la query suivante (Shopify GraphiQL, Admin
API, lecture seule) doit renvoyer **zéro** abonnement — puisqu'aucun abonnement shop-scoped n'a
encore été créé, et que les quatre du TOML sont invisibles ici par construction :

```graphql
query {
  webhookSubscriptions(first: 25) {
    edges { node { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } }
  }
}
```

Un résultat **non vide** avant toute exécution de `--apply` signalerait un abonnement shop-scoped
résiduel (installation antérieure, essai manuel) : le relever et le supprimer avant la bascule,
sans quoi `verifyAndCleanup` le traitera comme périmé au premier `--apply`.

Après l'étape 11 du runbook Option D, cette même query doit renvoyer **exactement huit**
abonnements, tous vers `/api/shopify/ingest/<jeton>` — et toujours **aucun** `app/uninstalled`.

---

## 5. Ce que ce lot ne fait pas

- Il **n'exécute pas** le déploiement (authentification interactive).
- Il **n'exécute pas** la bascule GETGET SN (runbook Option D, `WEBHOOK_PUBLIC_BASE_URL` reste le
  bloqueur du porteur).
- Il ne touche ni `shopify.app.toml` (Teer Dev) ni les autres apps du registre.
