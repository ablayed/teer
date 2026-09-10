# Rapport R2.4 — commit 3

## Résultat

[Décision] Le commit 3 livre un client WooCommerce REST pur, sa canonicalisation d’URL et sa garde SSRF. Il ne lit ni n’écrit Supabase, n’importe ni `env` ni une Server Action, et ne persiste aucun statut `needs_reauth`. La transition persistée appartient au consommateur ultérieur.

[Fait] Le client est construit autour de trois responsabilités séparées :

1. `normalizeWooCommerceIdentity` produit une clé d’identité ; elle n’autorise aucun appel réseau.
2. `validateAndPinHttpsTarget` filtre l’URL, résout toutes les adresses A/AAAA et produit une cible épinglée ; elle ne produit pas de clé d’identité.
3. `WooCommerceClient` appelle la cible épinglée, suit les redirections explicitement et classe les réponses.

## Canonicalisation

[Décision] La fonction `normalizeWooCommerceIdentity` accepte une URL absolue HTTPS sans identifiants, query, fragment ni port autre que 443. Le nom d’hôte est mis en minuscules et la sérialisation IDNA du parseur URL est conservée. `www` et non-`www` restent distincts ; le sous-répertoire WordPress reste significatif ; le port 443 est retiré ; les slashs finaux du chemin sont retirés sauf le slash racine.

[Fait] Les tests hermétiques couvrent la casse, `www`/non-`www`, sous-répertoire, port 443, slash final, nom terminé par un point, IDN/punycode, HTTP, identifiants d’URL, port non standard et zone IPv6 : [`url.test.ts`](../tests/unit/woocommerce/url.test.ts).

[Non vérifié] Ce commit ne prétend pas mesurer TLS public, DNS public, IDN public ni redirection inter-domaine. Les formes ambiguës testées sont des tests du parseur et du filtre, pas une mesure d’une boutique publique.

## DNS, rebinding et SSRF

[Décision] `validateAndPinHttpsTarget` filtre d’abord l’URL, puis résout le nom sans son éventuel point terminal. Toutes les réponses A/AAAA sont contrôlées ; une seule adresse interdite fait refuser l’ensemble. La première adresse restante est transportée dans `PinnedHttpsTarget`.

[Fait] Le transport HTTPS utilise `createPinnedLookup`, qui ignore toute résolution ultérieure du socket et rend l’adresse validée. Le hostname de la cible reste fourni à `hostname`, `Host` et `servername` pour conserver TLS/SNI. La mutation de ce pinning vers `127.0.0.1` fait échouer le test dédié.

[Fait] Les classes refusées sont : IPv4 non spécifiée, privées, loopback, link-local, CGNAT, documentation, benchmarking, multicast et réservée ; IPv6 non spécifiée, loopback, ULA, link-local, multicast, documentation et plage `2001::/23` ; IPv4 mappée IPv6, y compris les formes décimale et hexadécimale. Les adresses A/AAAA mélangées, les écritures numériques de loopback (`2130706433`, hexadécimale et octale), les zones IPv6 et les noms terminés par un point sont testés.

[Fait] Le filtre ne se confond pas avec la normalisation : les fonctions sont dans [`url.ts`](../lib/woocommerce/url.ts) et [`ssrf.ts`](../lib/woocommerce/ssrf.ts), et l’ordre d’appel du client est filtre/résolution/pinning puis requête.

## Redirections et limites globales

[Décision] Le client ne suit aucune redirection automatiquement. Il limite la chaîne à `WOO_MAX_REDIRECTS = 3`. Chaque `Location` est reconstruite contre la cible courante, reparsée comme HTTPS sans identifiants et repasse par la résolution complète avant l’appel suivant.

[Décision] Comme le client porte `Authorization`, une redirection qui change d’origine est refusée avant toute seconde requête. Ainsi le Basic Auth ne peut pas être transmis à un autre hôte. Les redirections HTTP et avec identifiants sont refusées.

[Décision] Le délai global est `WOO_REQUEST_TIMEOUT_MS = 10_000 ms` et la même échéance couvre DNS, connexion, redirections et lecture. La limite est `WOO_MAX_RESPONSE_BYTES = 1 MiB` sur les octets décompressés effectivement lus ; le transport décompresse gzip, deflate et Brotli avant le comptage. Une réponse de succès doit être JSON (`application/json` ou suffixe `+json`) et son JSON doit être valide.

[Fait] Les exceptions externes ne contiennent qu’un code stable : URL, credentials, réponse fournisseur et adresses résolues sensibles sont exclus. Les erreurs de transport injectées sont également ramenées à `upstream_error`.

## Identité et classification

[Fait] `readIdentity` lit la racine `/wp-json/`, exige `home` et `url`, normalise `home` avec exactement la même fonction que l’identité revendiquée, puis refuse une divergence avant de retourner la preuve `{ claimedIdentity, canonicalIdentity, restUrl, homeUrl }`. Le cas mesuré de `home_url('/')` avec slash final est couvert.

[Fait] Les réponses sont classées sans exposer le corps : `401` en credentials invalides, `403` en accès refusé, `429` en limitation, `5xx` en indisponibilité ; les codes WooCommerce d’authentification et d’accès sont également reconnus. Une réponse de succès non JSON ou JSON invalide est refusée.

## Preuve par mutations

[Fait] Chaque mutation a été appliquée seule, testée en rouge, puis restaurée :

| Garde mutée | Preuve rouge | Restauration |
|---|---|---|
| schéma HTTPS | test de destination HTTP en échec | verte |
| identifiants URL | test `user:password@` en échec | verte |
| port | test `:8443` en échec | verte |
| classes IPv4 | 20 assertions et le mélange DNS en échec | verte |
| classes IPv6 et IPv4 mappée | 9 assertions en échec | verte |
| ensemble DNS | mélange public + loopback accepté, test en échec | verte |
| pinning anti-rebinding | callback rendu `127.0.0.1`, test en échec | verte |
| redirection d’origine | tentative de second transport, code différent, test en échec | verte |
| protection Authorization | couverte par la même mutation de redirection, aucune seconde requête autorisée | verte |
| timeout | opérations lentes non interrompues à l’échéance, test en échec | verte |
| taille après décompression | corps gzip trop grand accepté, test en échec | verte |
| confrontation d’identité | boutique différente acceptée, test en échec | verte |

[Fait] Après restauration, `git diff --check` est propre et le diff de travail est revenu identique au contenu validé ; aucune mutation ne subsiste.

## Tests et limites du commit

[Fait] Tests ciblés : 3 fichiers, 61 tests chargés, 61 réussis (`tests/unit/woocommerce`). Le typage TypeScript est vert.

[Fait] Ce commit ne fournit pas encore l’adaptateur de commandes, les webhooks, la vérification HMAC, les abonnements, la synchronisation initiale, l’intention/callback, l’écriture via RPC, la transition `needs_reauth` ou l’interface. Il n’effectue aucun appel à une boutique réelle et ne modifie aucun chemin Shopify.

[Suspendu] Le client de production exige HTTPS ; l’instance WooCommerce locale HTTP n’est donc pas utilisée pour l’exercer. La preuve locale du réseau repose sur le résolveur et le transport injectés dans les tests hermétiques, sans variable d’environnement ni affaiblissement de SSRF.
