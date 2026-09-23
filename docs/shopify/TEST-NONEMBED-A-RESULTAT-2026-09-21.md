# TEST-NONEMBED-01, Test A — résultat mesuré en production le 21 septembre 2026

**Fichier de résultat, daté, non révisable.** Il porte les **mesures** de Test A. Les décisions et
règles durables qui en découlent sont dans `CLAUDE.md` (section « Shopify — architecture
d'ingestion multi-app ») ; elles ne sont pas répétées ici. La **procédure** de déploiement de
l'app reste dans `docs/shopify/teer-public-app-config.md`, qui ne doit porter aucune mesure.

Labels : `[Fait]` mesuré ou lu dans le dépôt · `[Décision]` · `[Recommandation]` · `[Non vérifié]`.

**Règle de lecture de tout ce document** : une mesure vaut pour la date et l'objet qu'elle nomme.
Aucune n'est rétroactive, aucune n'est transitive.

---

## 1. Le verdict

`[Fait]` **Une app publique non embarquée, avec `use_legacy_install_flow = false`, reçoit un code
d'autorisation sur son callback et obtient un jeton hors-ligne.** Mesuré en production, pas déduit.

Conditions exactes de la mesure :

| Élément | Valeur |
|---|---|
| Version Shopify active pendant le test | `teer-public-6` (`embedded = false`, `use_legacy_install_flow = false`) |
| App | Teer Public, `client_id` `86c612a670ee04fe488426f442037605` |
| Boutique | `teer-public-smoke.myshopify.com` (fixture synthétique) |
| Session | owner du locataire propriétaire |
| Date | 21 septembre 2026 |

Les cinq maillons du parcours, chacun franchi :

| # | Maillon | Résultat |
|---|---|---|
| 1 | `/api/shopify/install` appelée avec le `client_id` de Teer Public | franchi |
| 2 | `state` signé posé | franchi |
| 3 | Redirection vers Shopify, consentement, installation | franchi |
| 4 | Callback atteint avec `code` **et** `state` | franchi — `Referer: https://admin.shopify.com/` |
| 5 | Jeton persisté pour la bonne app | franchi — `status = active`, `shopify_client_id = 86c612…`, `scopes = read_customers,read_orders,read_products`, écrit à **20:08:53 UTC** |

`[Fait]` Le maillon 5 se conclut sur `shop.shopify_client_id`, jamais sur la seule présence d'un
jeton — c'est la garde contre le faux succès « j'ai installé Teer Dev sans m'en apercevoir »
(`tests/unit/shopify-install-app-selection.test.ts`).

`[Décision]` **`use_legacy_install_flow` reste `false`.** Le repli legacy prévu par le protocole ne
s'ouvre pas : il ne se touche que sur le verdict « échec du régime géré », et ce verdict n'est pas
tombé.

### 1.1 Pourquoi le message d'échec vu par l'opérateur ne contredit pas ce succès

`[Fait]` L'opérateur a vu « La connexion a échoué ». Le jeton était déjà écrit.

`[Fait]` Le callback a été invoqué **deux fois avec le même `code`** :

| Invocation | Heure locale (UTC+1) | Durée | Appels externes | Effet |
|---|---|---|---|---|
| 1ʳᵉ | 21:08:52 | 2,86 s | onze, dont deux `PATCH` | **a écrit le jeton** |
| 2ᵉ | 21:08:55 | 696 ms | quatre | a échoué, bannière rouge |

`[Fait]` Les horaires sont cohérents entre eux : 21:08:52 locale = 20:08:52 UTC, et le jeton est
écrit à 20:08:53 UTC, une seconde plus tard.

`[Non vérifié]` **La cause exacte du refus de la seconde invocation n'a pas été relevée.** La
réponse de Shopify à ce second échange — `invalid_grant`, code déjà consommé, ou autre — n'a pas
été observée.

`[Recommandation]` Le rejeu d'un code déjà consommé est l'explication principale. **Ce n'est pas
une preuve.** Ne jamais fondre les deux énoncés précédents en un seul. Canal pour trancher :
relever le corps de la réponse de `/admin/oauth/access_token` dans les journaux de la seconde
invocation, ou reproduire pendant Test B.

---

## 2. Les trois faits secondaires, et leur propriétaire

### 2.1 La boucle de l'entrée admin — appartient à Test B

`[Fait]` `application_url` pointe sur `/shopify/embedded/teer-public`. Avec `embedded = false`,
Shopify appelle cette URL avec `host` mais **sans** `embedded=1` ; `EmbeddedAppShell` redirige
alors vers l'Admin Shopify, qui rappelle Tëër. **Boucle de rafraîchissement, page jamais rendue.**

`[Décision]` Comportement **prévu avant la mesure**, écrit au §4 du protocole. **Ce n'est pas une
régression** : c'est le premier point du périmètre de Test B. C'est aussi le symptôme le plus
visible pour un relecteur — d'où le risque qu'il soit pris pour un défaut de ce lot.

`[Fait]` Shopify affiche déjà une icône de lien externe à côté de l'app dans la liste des apps
installées. C'est le seul endroit où le régime non embarqué se manifeste correctement aujourd'hui.

### 2.2 Le double appel du callback — appartient à Test B, comme anomalie à diagnostiquer

`[Décision]` Consigné **comme anomalie à diagnostiquer**, jamais comme correctif acquis : il peut
n'être qu'une conséquence de la boucle du §2.1.

`[Fait]` Impact réel sur un marchand : une bannière d'échec après une installation pourtant
réussie.

`[Décision]` Test B devra exiger, et vérifier : une seule installation réussie, **aucun** second
échange avec le même `code`, **aucune** bannière rouge après succès. **Et s'arrêter pour un lot
séparé si le callback reste répété malgré la suppression de la boucle** — ce serait alors un défaut
propre, pas un effet de bord.

### 2.3 Les jetons hors-ligne expirants — lot séparé `SHOPIFY-EXPIRING-TOKENS-01`

`[Fait]` L'échange s'est fait **sans `expiring=1`** : `refresh_token_encrypted` nul,
`access_token_expires_at` nul. Conforme au code actuel.

`[Fait]` Shopify impose les jetons hors-ligne expirants à **toutes** les apps publiques au
**1er janvier 2027**, et déjà aux apps publiques **créées après le 1er avril 2026**.

`[Décision]` **L'acceptation technique de l'échange ne vaut pas validation de conformité.** Shopify
a délivré un jeton non expirant : cela prouve que le grant fonctionne, **pas** que cette
configuration est conforme aux exigences de distribution. Ne pas confondre les deux.

`[Non vérifié]` **La date de création de Teer Public n'a jamais été relevée.** Elle est lisible dans
le Dev Dashboard. Elle décide de l'échéance réelle :

| Date de création | Conséquence |
|---|---|
| après le 1er avril 2026 | **l'écart existe déjà aujourd'hui**, pas seulement au 1er janvier 2027 |
| avant le 1er avril 2026 | échéance au 1er janvier 2027 |

`[Recommandation]` Relever cette date **avant la soumission**, et non comme un détail du lot de
jetons : selon la réponse, `SHOPIFY-EXPIRING-TOKENS-01` passe d'échéance lointaine à **écart
courant**.

`[Décision]` **Lot séparé, jamais Test B.** Motif : ce sujet change le cycle de vie des jetons,
leur rafraîchissement, leurs expirations et les scénarios de reprise. Mêlé à Test B, il rendrait
impossible de distinguer une panne de navigation d'une panne d'authentification longue durée.

---

## 3. État de la configuration à l'issue de Test A

`[Fait]` `teer-public-6` a été créée par `shopify app deploy --config teer-public --no-release`,
publiée à la main, puis **`teer-public-5` a été republiée** après Test A — pour ne pas laisser une
entrée admin en boucle sur une configuration publique.

`[Fait]` **Divergence assumée entre le dépôt et la production** : `main` porte `embedded = false`
(`shopify.app.teer-public.toml:23`) et son assertion de test attend `false`
(`tests/unit/shopify/teer-public-app-config.test.ts:65`), tandis que la production sert
`teer-public-5`, donc `embedded = true`.

`[Décision]` **Cette divergence ne se referme pas d'elle-même.** Elle devra l'être explicitement,
par la publication validée de Test B. Jusque-là, **toute vérification doit distinguer la
configuration du dépôt de la version Shopify active** : lire le TOML ne dit pas ce que Shopify sert.

### 3.1 Précondition formelle de Test B

`[Fait]` **La fixture reste installée et autorisée** : `status = active`, jeton présent. Le rollback
de version **ne désinstalle pas**.

`[Décision]` Avant toute mesure de Test B, quatre points **vérifiés et non supposés** :

1. désinstallation effectuée depuis l'admin de la boutique ;
2. **réception du webhook `app/uninstalled`** constatée sur
   `https://www.teerafrik.com/api/shopify/webhooks` ;
3. credentials effacés — `access_token_encrypted` **et** `refresh_token_encrypted` nuls ;
4. **état de `store_connection` vérifié**, statut compris.

Sans ces quatre points, toute mesure de Test B serait **une réautorisation déguisée en première
installation**.

---

## 4. Dettes relevées — consignées, aucune traitée

`[Décision]` Ce lot les écrit et rien de plus. Chacune porte sa date et son emplacement.

**1. `.gitleaks.toml` — une fausse clé de fixture fait rougir tout scan d'historique complet.**
`[Fait]` `tests/unit/shopify-offline-token.test.ts:10` porte
`'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'`, fixture introduite le
8 août 2026, et **ce fichier est absent de l'allowlist** de `.gitleaks.toml` (qui liste
`tests/unit/shopify-crypto.test.ts`, pas celui-ci). Le job `gitleaks` de `ci.yml:50-61` utilise
`fetch-depth: 0`. La variable réelle s'appelle `SHOPIFY_TOKEN_ENCRYPTION_KEY` (`lib/env.ts:40`), et
`docs/phaseU/FIX-ORD-01-RAPPORT.md` l'avait déjà qualifiée ; l'empreinte mesurée est distincte de
celle de la variable réelle.
`[Non vérifié]` **La comparaison à l'environnement Production n'a pas été faite.**

**2. La règle `workflow_dispatch` vivait hors de `CLAUDE.md`.**
`[Fait]` Le motif était écrit dans un rapport de lot, jamais dans `CLAUDE.md`, alors que ce même
rapport demandait qu'il y soit. **Elle a coûté une exécution CI.** Portée dans `CLAUDE.md` par ce
lot — c'est la seule des huit dettes à y figurer, parce que c'est une règle et non un constat.
`[Fait]` **Le déclencheur `workflow_dispatch:` est bien déclaré dans `ci.yml:9`.** L'interdiction
porte sur son **usage**, pas sur sa présence : ne pas « corriger » cette dette en retirant la ligne
du workflow.
`[Fait]` Trace mesurée : une exécution de `ci.yml` déclenchée par **`workflow_dispatch` sur `main`**
le 21 septembre 2026 à 13:37 UTC — run `35606768935` — s'est soldée par un **échec**.
`[Non vérifié]` Que ce run soit exactement « l'exécution coûtée » par l'absence de la règle n'a pas
été établi ; seule son existence et son issue le sont.

**3. Le `grep` de diagnostics assainis ne cherche pas `not found`.**
`[Fait]` Le motif `error|failed|failure|timeout|timed out|unable|cannot|denied|refused|network|connection|pull|download`
apparaît **six fois** dans `ci.yml` (l. 115, 209, 252, 467, 655, 819). Il contient `cannot` mais
**pas** `not found` — d'où un journal muet sous la mutation du `PATH`, où seul le code de sortie 127
a parlé.

**4. L'assertion de version de la CLI Supabase est silencieuse quand elle passe.**
`[Fait]` Six occurrences dans `ci.yml` (l. 104, 198, 241, 456, 644, 808) : la version est capturée
puis comparée, et **rien n'est écrit sauf en cas d'écart**. Un `echo` du numéro rendrait la preuve
lisible sans avoir à muter quoi que ce soit.

**5. `e2e-zero-flake` échoue à `Build production`, et l'échec est toujours d'actualité.**
`[Fait]` Dernière exécution verte : **22 juillet 2026**. Échecs mesurés : deux le 21 août 2026 sur
`bd740caa6310221f81bfe0ff2b342ec248b6845c` (runs `32476957827`, `32476948878`), puis un le
21 septembre 2026 sur `71e678463048f7efbc093786036f09bb16cbd7c4` — run `35631182280`, seule étape en
échec : **`Build production`**.
`[Fait]` **L'échec n'est donc pas circonscrit à `bd740ca` : il se reproduit sur le `main` courant.**
Personne ne l'avait vu, faute de déclencher ce workflow.
`[Décision]` **Un workflow qui ne produit plus de résultat sans que ça se remarque est pire qu'un
workflow rouge : c'est une garde qu'on croit avoir.**

**6. Aucun identifiant de déploiement exposé par l'application.**
`[Fait]` La recherche de `VERCEL_GIT_COMMIT_SHA` dans le code suivi rend **zéro occurrence**.
Conséquence : « quel code sert la production » n'est vérifiable que dans le tableau de bord Vercel,
par une seule personne, à chaque barrière.
`[Recommandation]` Une route de santé ou un en-tête de réponse le rendrait mesurable par n'importe
qui. Hors périmètre de ce lot.

**7. Les pulls d'images Docker dominent le coût de `ci.yml`.**
`[Fait, rapporté par le porteur]` **2 105 s cumulées par exécution**, contre 40 s gagnées par
`INFRA-SUPABASE-CLI-01`. Médiane passée de 92 s à 108 s **sans que le diff touche Docker**.
`[Décision]` **La variance de cette étape est elle-même large** : elle doit être mesurée avant de
conclure qu'un cache la réduirait. Lot distinct. Motif déjà catalogué en dette (i) de `CLAUDE.md` —
« un pull réseau non caché, non borné, au milieu d'un job long ».

**8. Un seul workflow hors `ci.yml` reste non exercé — et non deux.**
`[Fait]` **Correction d'un constat antérieur, par mesure du 23 septembre 2026.**
`acl-production-probe` **a été exercé après** `INFRA-SUPABASE-CLI-01` (mergé le 21 septembre 2026 à
18:17 +0100) : deux exécutions planifiées sur `main`, **vertes**, les 22 septembre (run
`35703564660`) et 23 septembre 2026 (run `35836049248`). Le workflow **est** concerné par le lot —
il porte la même assertion de CLI (`acl-production-probe.yml:38-49`).
`[Fait]` **Seul `update-visual-baselines` reste non exercé** : dernière exécution le 18 septembre
2026 (run `35366269153`), soit **avant** la fusion.
`[Fait]` `e2e-zero-flake` a bien été exercé et **sa chaîne CLI est verte** — son échec est ailleurs
(dette 5, étape `Build production`).

**9. `pnpm test:unit` est rouge en local sur toute machine hors UTC — dette rencontrée pendant CE
lot, absente de l'inventaire d'origine.**
`[Fait]` Mesuré le 23 septembre 2026 : `tests/unit/period-range.test.ts` échoue sur ses **3** tests
(`1 failed | 181 passed` sur 182 fichiers, `3 failed | 1492 passed` sur 1495 tests). Les trois
résultats sont décalés d'exactement **un jour en arrière** : `2026-06-21` au lieu de `2026-06-22`,
`2026-05-31` au lieu de `2026-06-01` (deux fois).
`[Fait]` **Cause établie par mutation de la variable, pas déduite** : le même fichier, relancé
`TZ=UTC`, rend **3 passed**. Le fuseau de la machine est `Europe/London` (UTC+1 en BST).
Le test fixe pourtant l'horloge (`vi.setSystemTime(new Date('2026-06-23T15:56:00.000Z'))`) — ce
n'est donc pas une dépendance à la date du jour, mais au **fuseau de la machine**.
`[Fait]` **CI est vert** : job `test-unit` de la dernière exécution `ci.yml` sur `main`
(run `35631065502`) → `success`. Les runners sont en UTC.
`[Décision]` **Conséquence à nommer, parce qu'elle touche une règle du projet** : la sanity loop de
la règle 6 (`pnpm typecheck && pnpm lint && pnpm test:unit && pnpm build`) **ne peut pas passer en
local** pour un développeur hors UTC. Un agent discipliné y lira un rouge à corriger et cherchera
une régression dans son diff — y compris sur un diff `.md` pur, comme ici.
`[Recommandation]` Famille déjà connue du projet (« les bornes de jour métier se calculent en TS et
se passent en `timestamptz` »). Correctif pressenti : épingler le fuseau dans la configuration
Vitest, ou rendre les trois assertions indépendantes du fuseau. **Non traité ici** — ce lot
n'ouvre aucun fichier exécutable.

---

## 5. Ce que ce lot n'a pas fait

`[Fait]` Aucun code, aucune migration, aucun test, aucun workflow, aucune modification du Partner
Dashboard, aucune publication Shopify. **Aucune des huit dettes n'a été corrigée.**

`[Fait]` Le contenu de Test B n'est pas anticipé au-delà de ce que le §2 en dit.
