# R2.3/R2.4 — préflight WooCommerce et arrêt A

Date : 2026-09-10  
Branche : `r2-woocommerce-credentials`  
Commit : 1/7 — forme et vérification, aucune migration écrite.

## Porte de départ

[Fait] `origin/main` pointe sur `2f502dc5f237440f3b690e71741ab57917dca175`, fusion de la PR #210 (`phaseR2: consigner la gouvernance avant R2.3 (#210)`). L'arbre était propre avant la création de la branche. La branche a été créée depuis ce SHA.

[Fait] La CI post-fusion est verte sur ce SHA : run `34525189267`, `status=completed`, `conclusion=success`, `headSha=2f502dc5f237440f3b690e71741ab57917dca175`. Les jobs attendus sont verts ; `l1-backfill-harness` est ignoré conformément au workflow.

[Fait] La lecture directe du catalogue de production a confirmé `0151` comme tête de migration. La requête de mesure de `ingestion_event.platform` a renvoyé une seule valeur : `shopify` (33 lignes). Aucun objet ni aucune donnée de production n'a été modifié.

## Instance locale éphémère

[Fait] Une instance locale, non productive et sans compte WooCommerce externe a été montée avec `wordpress:7.0-php8.3-apache`, MariaDB `11.4` et WooCommerce `11.1.0`, sur `http://127.0.0.1:18080`. Le plugin officiel a été activé localement. La configuration Apache de l'instance a dû être ajustée pour que le REST WordPress de l'image soit réellement servi ; cette modification est restée dans le conteneur éphémère.

[Fait] Un alias Apache réel `/wordpress/` vers la même installation a ensuite été activé. Avec `siteurl=home=http://127.0.0.1:18080/wordpress`, les deux routes suivantes ont répondu `200` et la racine REST a renvoyé `url` et `home` avec le sous-répertoire :

| Route | Résultat |
|---|---|
| `/wordpress/wp-json/` | `200` |
| `/wordpress/wp-json/wc/v3` | `200`, `namespace=wc/v3` |

[Fait] Mesure de référence, options restaurées à la fin :

| Réglage | Valeur |
|---|---|
| `siteurl` | `http://127.0.0.1:18080` |
| `home` | `http://127.0.0.1:18080` |
| `/wp-json/`.url | `http://127.0.0.1:18080` |
| `/wp-json/`.home | `http://127.0.0.1:18080` |
| racine `/wp-json/wc/v3` | `namespace=wc/v3` |

[Fait] Lorsque les options ont été rendues distinctes (`siteurl=http://127.0.0.1:18080/siteurl`, `home=http://127.0.0.1:18080`), la racine REST a renvoyé `url=siteurl` et `home=home`. `siteurl` décrit donc l'emplacement de l'installation ; `home`, utilisé par `home_url('/')`, est la valeur retenue pour l'identité publique de la boutique. La racine `wc/v3` ne fournit pas une seconde identité : elle décrit l'API et son namespace.

[Fait] Variations mesurées sur la même instance :

| Cas | Réglage | `/wp-json/`.url | `/wp-json/`.home |
|---|---|---|---|
| sans slash | `http://127.0.0.1:18080` | sans slash | sans slash |
| slash final | `http://127.0.0.1:18080/` | slash retiré | slash retiré |
| casse du nom d'hôte | `http://LOCALHOST:18080` | casse conservée par WordPress | casse conservée par WordPress |
| non-www | `http://localhost:18080` | `localhost` | `localhost` |
| www | `http://www.localhost:18080` | `www.localhost` | `www.localhost` |
| sous-répertoire | `http://127.0.0.1:18080/wordpress` | chemin conservé | chemin conservé |
| sous-répertoire + slash | `http://127.0.0.1:18080/wordpress/` | slash retiré | slash retiré |
| port explicite | `http://127.0.0.1:18080` | `:18080` conservé | `:18080` conservé |

[Non vérifié] Le réseau local n'a pas permis de mesurer TLS public, DNS public, redirection inter-domaine ni un véritable domaine IDN. `www.localhost` et `localhost` ont été distinguables comme valeurs de configuration, pas comme une preuve de deux vhosts ou de deux DNS publics. Ces cas seront couverts par des tests hermétiques du filtre applicatif.

## Les six vérifications WooCommerce

### 1. Identité externe et normalisation

[Fait officiel + source] WordPress expose la découverte REST sur `/wp-json/`; la documentation de découverte et l'API REST décrivent cette racine : [WordPress REST API — découverte](https://developer.wordpress.org/rest-api/using-the-rest-api/discovery/). La documentation des options distingue `siteurl` et `home` : [WordPress Options API](https://developer.wordpress.org/apis/options/) et [home_url()](https://developer.wordpress.org/reference/functions/home_url/).

[Fait mesuré local] La racine REST renvoie `url` depuis `siteurl` et `home` depuis `home`. La racine `wc/v3` renvoie le namespace `wc/v3`; elle ne constitue pas l'identité de la boutique. La valeur autoritative du connecteur sera `home` relue depuis la racine REST, avec une comparaison séparée de `url` si nécessaire pour le diagnostic. L'identité est prouvée par la relecture HTTPS authentifiée et non par un booléen de connexion.

[Fait officiel + source] Le code WooCommerce construit `X-WC-Webhook-Source` avec `home_url('/')` dans [`class-wc-webhook.php`](https://github.com/woocommerce/woocommerce/blob/trunk/plugins/woocommerce/includes/class-wc-webhook.php). Il ajoute donc un slash final à la valeur de `home`.

[Décision] `X-WC-Webhook-Source` passe exactement par la même fonction de normalisation que l'identité WooCommerce persistée, avant toute confrontation. Le cas mesuré `home_url('/')=http://127.0.0.1:18080/` est donc normalisé en `http://127.0.0.1:18080` avant comparaison ; aucune seconde règle dédiée aux headers n'existe.

[Décision] Normalisation de la clé d'identité :

1. parser une URL absolue avec le parseur URL de la plateforme ;
2. accepter en production uniquement `https`, sans identifiant utilisateur/mot de passe, sans query ni fragment ;
3. mettre le nom d'hôte en minuscules et sérialiser la représentation IDNA/punycode du parseur ;
4. conserver `www` : `www.example.test` et `example.test` restent deux identités tant que WooCommerce ne prouve pas la même valeur canonique ;
5. conserver le sous-répertoire, retirer les slash finaux du chemin sauf le slash racine ;
6. retirer le port explicite `443`, refuser tout autre port dans le connecteur MVP ;
7. ne jamais normaliser une URL locale HTTP vers HTTPS : les mesures HTTP sont uniquement des mesures de comportement de WordPress.

[Non vérifié] Le comportement d'un domaine public IDN/punycode et de redirections inter-domaines n'a pas été mesuré localement. La règle ci-dessus sera vérifiée par tests hermétiques, sans présenter cette couverture comme une mesure de WooCommerce.

### 2. Identifiant mondial immuable

[Fait officiel + source] La documentation REST de WooCommerce décrit les clés de l'API, les webhooks et les ressources, mais ne fournit pas d'identifiant mondial immuable de boutique : [WooCommerce REST API](https://woocommerce.github.io/woocommerce-rest-api-docs/).

[Absent de la documentation] Aucun identifiant mondial immuable n'a été trouvé dans la racine REST, la racine `wc/v3`, les options `siteurl`/`home` ou la documentation officielle consultée. L'identité externe reste donc l'URL HTTPS normalisée et vérifiée. Elle est mutable et ne sera jamais qualifiée d'immuable dans le code, l'interface ou la documentation.

### 3. Secret HMAC et champ de création

[Fait officiel + source] La création d'un webhook accepte les champs `topic`, `delivery_url` et `secret` dans l'API REST ; le secret peut être renseigné explicitement : [WooCommerce webhooks REST API](https://developer.woocommerce.com/docs/apis/rest-api/v2/webhooks). La documentation générale précise qu'un secret vide peut reprendre le consumer secret : [WooCommerce Webhooks](https://woocommerce.com/document/webhooks/). Le connecteur transmettra donc toujours un secret généré par Tëër dans le champ `secret` et ne s'appuiera jamais sur cette valeur implicite.

[Fait officiel + source] WooCommerce calcule `X-WC-Webhook-Signature` par HMAC-SHA256 en base64 sur le corps JSON brut dans [`class-wc-webhook.php`](https://github.com/woocommerce/woocommerce/blob/trunk/plugins/woocommerce/includes/class-wc-webhook.php). Le préflight local l'a reproduit : avec le secret `teer-preflight-hmac-secret`, le HMAC du corps brut capturé correspondait exactement à la signature émise.

### 4. `X-WC-Webhook-Delivery-ID`

[Fait officiel + source] Le code WooCommerce fabrique le header de livraison à partir de l'identifiant du webhook et de `strtotime('now')`, via `get_new_delivery_id()` : [`class-wc-webhook.php`](https://github.com/woocommerce/woocommerce/blob/trunk/plugins/woocommerce/includes/class-wc-webhook.php). Ce n'est donc ni un identifiant mondial de commande, ni une preuve d'unicité durable par livraison.

[Fait mesuré local] Deux livraisons du même webhook séparées de deux secondes ont donné deux valeurs différentes. Quatre livraisons déclenchées dans la même seconde ont partagé `27fcde6d5ed88139d07a62e0aa86a11c`. Le header sera journalisé pour la traçabilité et pour écarter la répétition d'une même livraison, jamais comme idempotence métier. L'idempotence sera `(connexion, type d'entité, identifiant externe)` avec garde de fraîcheur.

### 5. SSRF

[Décision] Toute URL fournie par le marchand passe par un filtre dédié avant le premier appel et chaque redirection repasse par ce filtre. Le filtre refuse :

- tout schéma autre que `https` ;
- tout `user:password@` ;
- tout port autre que `443` ;
- loopback, réseaux privés, link-local, CGNAT, adresses réservées, multicast et documentation, en IPv4 et IPv6, y compris IPv4-mapped IPv6 ;
- les résolutions DNS dont une adresse de destination appartient à l'une de ces classes ;
- les réponses dépassant `1 MiB` et les appels dépassant `10 s` ;
- plus de `3` redirections ; chaque destination est parsée, résolue et contrôlée avant suivi.

[Fait officiel + source] WordPress applique un contrôle de destination et revalide les redirections avec `wp_safe_remote_request()` et `wp_http_validate_url()` : [wp_safe_remote_request()](https://developer.wordpress.org/reference/functions/wp_safe_remote_request/) et [wp_http_validate_url()](https://developer.wordpress.org/reference/functions/wp_http_validate_url/). Tëër conservera une garde explicite côté connecteur, notamment pour la politique de port, les formes IPv6 mappées et la résolution par saut.

[Non vérifié] Aucun TLS public, DNS public ou redirection inter-domaine n'a été mesuré dans l'environnement local. Les classes d'adresses interdites, le port, les identifiants, le schéma, les limites et les redirections seront donc prouvés par tests hermétiques et mutations du filtre.

### 6. Statuts et topics MVP

[Fait officiel + source] Les statuts documentés des commandes WooCommerce sont Draft, Pending payment, Processing, Completed, On hold, Failed, Cancelled et Refunded, avec leur sémantique décrite ici : [WooCommerce — Order statuses](https://woocommerce.com/document/managing-orders/order-statuses/).

[Fait officiel + source] Les topics de webhook officiels incluent `order.created`, `order.updated` et `order.deleted` : [WooCommerce REST API — webhooks](https://developer.woocommerce.com/docs/apis/rest-api/v2/webhooks).

[Décision] Le plus petit ensemble du MVP est `order.created` et `order.updated`. `order.deleted` n'est pas souscrit : le MVP ne promet ni suppression métier ni remboursement, et la synchronisation bornée relit les commandes de la fenêtre. Aucun topic produit, client, coupon ou remboursement n'est créé.

## Borne de synchronisation initiale

[Décision] La synchronisation initiale couvre exactement les commandes dont `date_created_gmt` est dans l'intervalle `[window_start, window_end)`. `window_start` est l'instant UTC tronqué à la seconde moins 90 jours. `window_end` est calculé au démarrage de la synchronisation, après que la connexion est passée à `active` et que les abonnements ont été créés puis vérifiés par relecture ; il n'est jamais fixé au callback d'autorisation. Toute commande créée après `window_end` est hors de cette synchronisation, même si elle arrive pendant le scan ; elle doit passer par le webhook. La borne est donc fixe et non recalculée lors d'une reprise.

[Fait officiel + source] Le contrôleur WooCommerce accepte `after`, `before`, `dates_are_gmt`, `page`, `per_page`, `order` et `orderby`, ainsi que `modified_after`; le code ajoute `ID` à l'ordre lorsque `orderby=date` ou `modified` : [contrôleur REST des commandes WooCommerce](https://github.com/woocommerce/woocommerce/blob/trunk/plugins/woocommerce/includes/rest-api/Controllers/Version3/class-wc-rest-crud-controller.php). [Décision] Le connecteur n'utilise pas `modified_after` comme curseur : ce filtre sélectionne un autre ensemble et une modification peut déplacer une ressource dans le résultat.

[Décision] Chaque appel utilise `dates_are_gmt=true`, `orderby=date`, `order=asc`, `per_page=100`, `after=window_start - 1 seconde` et `before=window_end`. L'élargissement d'une seconde compense la précision de date de l'API ; l'adaptateur applique ensuite strictement `[window_start, window_end)` sur `date_created_gmt`. Le tri effectif attendu est `(date_created_gmt ASC, id ASC)` ; l'adaptateur vérifie cette monotonicité dans chaque page et refuse fermé toute réponse qui la viole. `page` est une position de lecture bornée, jamais un curseur sûr.

[Décision] La première réponse capture `X-WP-Total` et `X-WP-TotalPages` comme compteurs de référence. Chaque réponse suivante doit porter les mêmes compteurs, y compris la dernière ; une absence, une valeur non entière, une variation ou une incohérence avec la progression rend le scan `failed`, avec un code persistant borné tel que `pagination_total_changed`, conforme à `^[a-z0-9_]{1,64}$`. Ce contrôle détecte notamment une suppression ou une mise à la corbeille qui modifie le total ; il ne prétend pas garantir l'absence de toutes les mutations possibles.

[Décision] Une ligne enfant `store_connection_sync_state`, une par connexion, porte `window_start`, `window_end`, `last_page_observed`, `attempt`, `status`, `last_error_code`, `updated_at` et `completed_at`. `last_page_observed` est une trace de progression, pas le point de reprise. Après interruption ou erreur, la reprise repart obligatoirement de `page=1` avec la même fenêtre et le même tri, puis parcourt de nouveau toutes les pages. Cette stratégie est volontairement plus coûteuse : elle ne fait pas dépendre l'exhaustivité d'un offset susceptible de changer.

[Décision] Chaque ressource de chaque page est envoyée au même adaptateur pur et à la même RPC générique. La RPC déduplique sur `(store_connection_id, entity_type, external_id)` et n'applique une mise à jour que si le signal de fraîcheur est plus récent. Une page relue ne crée donc pas de seconde commande. Une commande existante modifiée pendant le scan conserve son `date_created_gmt` et son rang de tri ; sa version observée par le scan est protégée par la garde de fraîcheur. Une commande créée pendant le provisionnement, après le callback mais avant l'activation et le début du scan, est incluse si son `date_created_gmt` appartient à `[window_start, window_end)` ; son webhook éventuellement refusé parce que la connexion n'était pas encore `active` n'empêche pas son import initial. Une commande créée après `window_end` est hors fenêtre ; le webhook la prend en charge.

[Preuve attendue au commit 6] Le test de reprise injectera une interruption après la première page, créera une commande après `window_end`, modifiera une commande déjà dans la fenêtre, puis relancera depuis `page=1`. Il vérifiera que la nouvelle commande n'est pas importée par le scan borné, que la commande modifiée ne produit qu'une ressource finale selon la garde de fraîcheur et qu'aucune commande de la fenêtre n'est dupliquée. Un second scénario créera une commande pendant le provisionnement, fera refuser son webhook tant que la connexion n'est pas `active`, puis vérifiera que l'import initial la récupère si elle appartient à la fenêtre. Le test vérifiera aussi qu'une réponse non triée, un déplacement de `date_created_gmt` ou une variation de `X-WP-Total`/`X-WP-TotalPages` n'est pas accepté silencieusement.

## `/wc-auth/v1/authorize` mesuré localement

[Fait mesuré local] Dans l'image locale, l'URL pretty `/wc-auth/v1/authorize` répondait `404` car la configuration de réécriture Apache de l'image n'était pas activée. La même API WooCommerce a été mesurée par sa forme query réellement construite par le code installé : `http://127.0.0.1:18080/index.php?wc-auth-version=1&wc-auth-route=authorize`. Le lien d'approbation généré par Woo était lui-même de la forme `http://127.0.0.1:18080/?wc-auth/v1=access_granted...`. Ce résultat décrit l'installation locale et ne transforme pas un `return_url?success=1` en preuve de connexion.

[Fait mesuré local] Avec une session administrateur locale et `scope=read_write`, `app_name=Teer Preflight`, `user_id=wc_intent_opaque_auth_6`, `return_url=http://127.0.0.1:18080/return` et `callback_url=https://example.com/callback`, l'écran d'autorisation a répondu `200`, titre `Application authentication request`, avec le consentement et le lien `access_granted`. Le callback a été intercepté par un hook HTTP local avant toute sortie réseau.

[Fait mesuré local] L'autorisation a accepté le callback et a émis un `POST` vers `https://example.com/callback`, `Content-Type: application/json;charset=UTF-8`. Le JSON contient exactement `key_id`, `user_id`, `consumer_key`, `consumer_secret`, `key_permissions`. Mesure capturée : `key_id=1`, `user_id=wc_intent_opaque_auth_6`, `key_permissions=read_write`, `consumer_key` préfixé `ck_` et `consumer_secret` préfixé `cs_`, chacun de 43 caractères. Les valeurs complètes n'ont pas été recopiées.

[Fait officiel + source] Le code WooCommerce valide les cinq paramètres `app_name`, `user_id`, `return_url`, `callback_url`, `scope`, limite `scope` à `read`, `write` ou `read_write`, exige un `callback_url` HTTPS, crée les clés et POSTe ce JSON : [`class-wc-auth.php`](https://github.com/woocommerce/woocommerce/blob/trunk/plugins/woocommerce/includes/class-wc-auth.php). [Absent de la documentation] La documentation ne décrit aucune signature ni protection anti-rejeu du POST callback ; l'intention opaque monousage de Tëër est donc la garde de rattachement.

[Fait mesuré local] Un callback `http://...` a été refusé avant l'écran de consentement par le contrôle `callback_url needs to be over SSL` ; il ne produisait ni lien d'approbation ni callback. [Non vérifié] Le callback HTTPS a été validé par WooCommerce, mais aucun TLS public n'a été établi dans le préflight : `example.com` était une URL de validation, et le POST a été intercepté localement. La production exigera donc une URL Tëër HTTPS réelle, un certificat public valide et une route callback SSRF-safe ; le test local ne prouve pas ces propriétés réseau.

## Limites non bloquantes

[Décision] `read_write` dépasse les besoins d'écriture de commandes du MVP, mais WooCommerce l'exige ici pour autoriser la création des abonnements par API. Ce sur-privilège est connu, documenté et limité à la phase de connexion ; aucun accès catalogue ne sera utilisé par le périmètre métier.

[Fait] Le callback WooCommerce n'a pas été testé de bout en bout localement avec une vraie terminaison TLS : `callback_url` doit être HTTPS. Le POST synthétique capturé localement prouve toutefois sa méthode, son schéma JSON et ses cinq champs ; il ne prouve ni certificat public ni livraison réseau.

[Décision] Les propriétés sous contrôle de Tëër restent prouvées par tests et mesures locales : intention opaque, verrouillage, expiration, monousage, validation des clés, normalisation d'identité et persistance atomique. Aucune tentative de tunnel ni aucun affaiblissement de la protection SSRF n'est autorisé.

## Forme figée proposée

Les tables ci-dessous sont la forme soumise à l'arrêt A. Les types sont PostgreSQL ; `NN` signifie non nullable. Les lignes Shopify et YouCan sont une démonstration de représentabilité, pas une création ou un déplacement de secret.

### `store_connection_credential`

| Colonne | Type | Nullabilité | Shopify | YouCan | WooCommerce |
|---|---|---|---|---|---|
| `id` | `uuid` | NN | génération théorique | génération théorique | génération de la clé |
| `scheme` | `text` | NN, liste fermée | `oauth_bearer` représentable, aucune ligne créée | `oauth_bearer` | `basic_consumer` |
| `store_connection_id` | `uuid` | NN | parent théorique | parent théorique | parent |
| `merchant_account_id` | `uuid` | NN | FK de contexte | FK de contexte | FK composite |
| `shop_id` | `uuid` | NN | FK de contexte | FK de contexte | FK composite |
| `key_id` | `text` | nullable | null ; les jetons restent sur `shop` | null ou identifiant de génération | `key_id` Woo, non globalement unique |
| `access_token_encrypted` | `text` | nullable | représentable, mais aucune duplication depuis `shop` | `access_token` chiffré par boutique | null |
| `refresh_token_encrypted` | `text` | nullable | représentable si présent selon `token.ts`, sans déplacement | `refresh_token` chiffré | null |
| `access_token_expires_at` | `timestamptz` | nullable | échéance si connue | environ 15 jours | null : aucune expiration protocolaire documentée |
| `refresh_token_expires_at` | `timestamptz` | nullable | null ou échéance connue | optionnel | null |
| `consumer_key_encrypted` | `text` | nullable | null | null | consumer key par boutique |
| `consumer_secret_encrypted` | `text` | nullable | null | null | consumer secret par boutique |
| `key_permissions` | `text` | nullable | null | scope selon fournisseur | valeur callback, attendue `read_write` |
| `created_at` | `timestamptz` | NN | métadonnée théorique | métadonnée | métadonnée |
| `updated_at` | `timestamptz` | NN | métadonnée théorique | métadonnée | métadonnée |
| `revoked_at` | `timestamptz` | nullable | révocation existante hors de cette table | révocation future | révocation détectée par appel API |

[Décision] `key_id` distingue les générations dans la boutique concernée ; aucune unicité globale n'est supposée. Expiration et refresh token sont optionnels : ils ne sont pas imposés à WooCommerce.

[Décision] Un index unique partiel impose au plus une génération non révoquée par `store_connection_id` : `UNIQUE (store_connection_id) WHERE revoked_at IS NULL`. Toute rotation révoque l'ancienne génération avant, ou dans la même transaction que, l'activation de la nouvelle. Aucun lecteur ne choisit entre plusieurs credentials courants. Le régime de lecture est sélectionné par `scheme` (`basic_consumer` ou `oauth_bearer`) ; il n'est jamais inféré de la nullabilité des secrets.

[Décision] La clé générique sera `CONNECTOR_CREDENTIALS_ENCRYPTION_KEY`, avec `CONNECTOR_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS`, en reprenant le format AES-256-GCM et le mécanisme de rotation de [`lib/shopify/crypto.ts`](../lib/shopify/crypto.ts). `SHOPIFY_TOKEN_ENCRYPTION_KEY` reste spécifique à Shopify et son régime n'est pas dégradé. Les tokens Shopify restent sur `shop`, sans ligne créée, déplacée ou dupliquée.

### `store_connection_webhook_subscription`

| Colonne | Type | Nullabilité | Shopify | YouCan | WooCommerce |
|---|---|---|---|---|---|
| `id` | `uuid` | NN | non utilisée dans ce lot | forme future | identifiant local |
| `store_connection_id` | `uuid` | NN | non utilisée | forme future | parent |
| `merchant_account_id` | `uuid` | NN | contexte du parent | contexte du parent | copié explicitement du parent |
| `shop_id` | `uuid` | NN | contexte du parent | contexte du parent | copié explicitement du parent |
| `provider_subscription_id` | `text` | nullable | non utilisée | non utilisée | identifiant webhook Woo, integer sérialisé |
| `topic` | `text` | NN | non utilisée | non utilisée | `order.created` ou `order.updated` |
| `delivery_token_hash` | `text` | NN, unique | capacité non nécessaire | futur | hash de l'identifiant opaque placé dans l'URL |
| `secret_encrypted` | `text` | NN | non utilisée | non utilisée | secret HMAC distinct par abonnement |
| `status` | `text` | NN | non utilisée | non utilisée | `provisioning`, `active` ou `disabled` |
| `created_at` | `timestamptz` | NN | métadonnée | métadonnée | métadonnée |
| `updated_at` | `timestamptz` | NN | métadonnée | métadonnée | métadonnée |

[Décision] Une table enfant est retenue plutôt qu'une ligne de credentials contenant une collection de secrets : chaque topic possède son secret chiffré, son identifiant fournisseur et son cycle de provisionnement. Une contrainte unique sur `(store_connection_id, topic)` interdit deux abonnements au même topic pour une connexion. Le token brut de livraison n'est jamais persisté ; sa représentation hashée est unique. Le lien enfant porte explicitement le `shop_id` du parent et ne dépend d'aucun trigger de boutique par défaut.

### `store_connection_sync_state`

| Colonne | Type | Nullabilité | Shopify | YouCan | WooCommerce |
|---|---|---|---|---|---|
| `id` | `uuid` | NN | non utilisée | forme future | identifiant local |
| `store_connection_id` | `uuid` | NN, unique | non utilisée | forme future | parent |
| `merchant_account_id` | `uuid` | NN | non utilisée | contexte | parent explicite |
| `shop_id` | `uuid` | NN | non utilisée | contexte | parent explicite |
| `window_start` | `timestamptz` | NN | non utilisée | futur | début fixe des 90 jours |
| `window_end` | `timestamptz` | NN | non utilisée | futur | fin fixe de la fenêtre |
| `last_page_observed` | `integer` | NN | non utilisée | futur | trace de progression, jamais curseur de reprise |
| `attempt` | `integer` | NN | non utilisée | futur | numéro de tentative borné |
| `status` | `text` | NN | non utilisée | futur | `pending`, `running`, `completed` ou `failed` |
| `last_error_code` | `text` | nullable | non utilisée | futur | code borné, jamais payload |
| `updated_at` | `timestamptz` | NN | non utilisée | futur | état et progression persistés |
| `completed_at` | `timestamptz` | nullable | non utilisée | futur | fin de l'import |

### `store_connection_intent`

| Colonne | Type | Nullabilité | Shopify | YouCan | WooCommerce |
|---|---|---|---|---|---|
| `id` | `uuid` | NN | forme théorique | forme future | identifiant opaque aléatoire envoyé comme `user_id` |
| `merchant_account_id` | `uuid` | NN | rattachement | rattachement | tenant de l'intention |
| `shop_id` | `uuid` | NN | rattachement | rattachement | boutique cible |
| `platform` | `text` | NN | `shopify` théorique | futur, non activé | `woocommerce` |
| `external_identifier` | `text` | NN | identité fournisseur théorique | identité fournisseur future | URL `home` HTTPS normalisée revendiquée |
| `created_by_member_id` | `uuid` | NN | membre créateur | membre créateur | membre `owner` ou `manager` |
| `expires_at` | `timestamptz` | NN | courte durée | courte durée | courte durée |
| `consumed_at` | `timestamptz` | nullable | monousage | monousage | null puis horodaté atomiquement |
| `created_at` | `timestamptz` | NN | métadonnée | métadonnée | métadonnée |

[Décision] L'intention est verrouillée, vérifiée (expiration/non-consommation), puis consommée atomiquement avec la connexion. `user_id` de `/wc-auth/v1/authorize` ne contiendra jamais un UUID de tenant, de boutique ou de membre.

Toutes les tables de credentials, subscriptions, sync state et intents seront `FORCE ROW LEVEL SECURITY`, sans policy, révoquées nominativement pour `public, anon, authenticated`, et utilisables par `service_role` uniquement. Chaque table enfant portera la FK composite `(store_connection_id, merchant_account_id, shop_id)` vers `store_connection(id, merchant_account_id, shop_id)` ; la table d'intention portera le rattachement composite au shop et au compte.

## Décisions de forme complémentaires

### États de connexion

[Décision] Les quatre états canoniques nouveaux sont :

1. `provisioning` : credentials vérifiés, intention consommée, abonnements pas encore vérifiés ;
2. `active` : connexion opérationnelle ;
3. `needs_reauth` : credentials invalidés lors d'un appel API, reprise nécessaire ;
4. `disconnected` : déconnexion explicite.

[Fait] `uninstalled` est un statut Shopify courant, encore écrit par `processAppUninstalledCore` à chaque désinstallation ([code du chemin Shopify](../lib/shopify/webhook-core.ts)). Il est conservé jusqu'à R2.7 ; il ne décrit pas une clé WooCommerce révoquée. WooCommerce utilise `needs_reauth` pour une invalidation détectée par appel API et `disconnected` pour une déconnexion explicite. La convergence du vocabulaire `disconnected`/`uninstalled`, actuellement analogue mais dépendante de la plateforme, appartient à R2.7.

[Décision] Le CHECK conserve donc les quatre états canoniques et autorise séparément `uninstalled` pour `platform='shopify'`, sans réécrire les lignes Shopify ni modifier leur chemin d'écriture.

### `ingestion_event.platform`

[Fait mesuré production] Les valeurs distinctes actuelles sont `{shopify}` avec 33 lignes. Elles ne permettent pas de conclure que la future liste fermée `{shopify, csv, woocommerce}` est déjà compatible avec toutes les données ni avec les écritures natives CSV.

[Décision] Aucun CHECK `ingestion_event.platform` n'est ajouté en `0152`. Le fondateur pourra reprendre ce relevé sur le catalogue de production avec :

```sql
select platform, count(*)::bigint as n
from public.ingestion_event
group by platform
order by platform;
```

Le CHECK sera différé tant que le relevé ne prouve pas l'ensemble attendu. La colonne restera nullable dans les autres chemins conformément au schéma existant ; `ingestion_event.store_connection_id` reste nullable et une source sans connexion n'en invente pas.

### Provisionnement et HMAC

[Décision] La séquence figée est : callback verrouille et consomme l'intention, vérifie les credentials et persiste atomiquement la connexion en `provisioning` ; création des deux abonnements avec secrets distincts et URL contenant un token opaque ; relecture et confrontation du topic et de l'URL de chaque abonnement ; passage à `active` ; synchronisation initiale bornée avec fenêtre et point de reprise persistés. Le point de reprise ne sert jamais de curseur API : toute reprise repart de `page=1`.

[Décision] À la réception, le token opaque de l'URL est hashé et sélectionne uniquement la ligne d'abonnement et son secret chiffré. Aucun compte, boutique ou contexte de tenant n'est accordé à cette étape. Après vérification HMAC sur le corps brut, la connexion est résolue depuis la ligne enfant, puis `X-WC-Webhook-Source`, le topic et les identités attendues sont confrontés. Seulement alors l'écriture commence. Un token inconnu, une signature fausse ou une discordance répondent de façon indifférenciée et n'écrivent rien.

### RPC générique

[Décision] `persist_connection_order` sera une nouvelle RPC atomique `SECURITY INVOKER`, appelée avec le contexte de connexion résolu (`store_connection_id`, `merchant_account_id`, `shop_id`, plateforme et identité d'ordre). Elle portera l'idempotence par ressource et la garde de fraîcheur du moteur commun. `create_csv_order` n'est pas modifiée dans ce commit et ne sera pas convertie dans cette migration ; sa conversion reste différée tant que la RPC distincte est utilisée.

## Arrêt A

[Suspendu] Le commit 1 contient uniquement ce rapport. Aucun fichier SQL n'a été créé, aucune ligne de SQL de migration n'a été écrite, et aucune référence TypeScript à cette forme ne sera ajoutée avant confirmation.

La forme proposée est-elle confirmée, en particulier la coexistence de `shopify/uninstalled` avec les quatre états canoniques, les quatre tables nommées, la borne de 90 jours et l'absence de CHECK `ingestion_event.platform` dans `0152` ?
