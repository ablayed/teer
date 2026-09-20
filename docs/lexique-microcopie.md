# Lexique de microcopie — Tëër

Table de décisions figées sur le vocabulaire et le registre des chaînes adressées au marchand.
Consultez-la avant de réintroduire une notion écartée ou de choisir un registre — les deux
entrées ci-dessous existent précisément pour qu'une notion déjà tranchée ne soit pas réintroduite
« par oubli » depuis une source de recherche externe ou une habitude de rédaction.

## Notions interdites

| Terme / notion | Statut | Raison |
|---|---|---|
| « Coût de reprise d'un colis refusé », « coût de retour », « coût de refus » | **Hors modèle — interdit.** | Introduit depuis la recherche de conception (vrai sur d'autres marchés), mais faux ici : les refus sont rares et le coût, quand il existe, est porté par le client qui paie le livreur — jamais le marchand. Le contrat F0 confirme qu'un colis refusé avant encaissement n'engendre ni dette ni coût livreur. Décision du fondateur (Lot U1-F-bis, 2026-08-28), pas un oubli — ne pas la réintroduire depuis un document de recherche. |

## Registre

| Règle | Statut | Raison |
|---|---|---|
| Vouvoiement, sans exception | **Obligatoire.** Toute chaîne adressée à l'utilisateur emploie « vous ». Le tutoiement est interdit, y compris dans les états vides et les messages d'erreur. | Tëër est un outil professionnel. « Vous avez encaissé » reste clair et respectueux, sans une familiarité qui n'a jamais été choisie. Décision du fondateur (Lot U1-F-bis, 2026-08-28). |

## Formulations figées

| Chaîne | Statut | Raison |
|---|---|---|
| « Marge provisoire — en attente de : {liste des coûts manquants} » | **Formulation figée.** Nomme explicitement CHAQUE entrée manquante (ex. « Transport pas encore facturé », « Publicité pas encore saisie ») — jamais un « Marge provisoire » nu sans dire quoi manque. | Lot F2 (rentabilité par arrivage), `purchase-lot-detail-panel.tsx` (`MISSING_INPUT_LABELS`/`missingInputLabel`). Une marge provisoire sans le détail de ce qui manque oblige le marchand à deviner ; le nommer explicitement est ce qui rend la ligne actionnable. |
| « Pas encore de CA encaissé sur cet arrivage » | **Formulation figée**, réutilisée verbatim entre la fiche détail et la carte liste (`MARGIN_PCT_MISSING_LABEL`, exporté de `purchase-lot-detail-panel.tsx`, importé par `purchase-lots-view.tsx`). | Une marge % avec `cashCollectedMinor === 0` n'est PAS « marge de 0 % » (un fait confirmé) mais l'absence totale de la donnée amont dont la marge % dérive — rendue via `ValueAmount`/`kind:'missing'` (dash + libellé), jamais un « 0,0 % » qui se lirait comme un chiffre confiant. Lot F2. |
| « Enregistrer » → « Enregistré sur l'appareil — en attente de synchronisation » → « Enregistré » | **Vocabulaire canonique à réutiliser verbatim** (tiret cadratin `—` inclus) pour TOUTE future UI de mutation offline-durable de ce projet, pas seulement Lot F2. | Introduit par `WEIGHT_BUTTON_LABEL` (`purchase-lot-detail-panel.tsx`) puis repris tel quel par `AD_SPEND_BUTTON_LABEL` (`product-ad-spend-form.tsx`) avec un commentaire explicite « pattern déjà revu deux fois sur ce fichier, ne pas le retaper de mémoire ». Les états intermédiaires « Enregistrement… » (écriture en vol) et « Réessayer » (échec confirmé, retry) complètent le cycle mais ne sont pas le nom de la formulation figée — c'est la paire idle→queued→synced qui doit rester identique mot pour mot d'un formulaire offline à l'autre. |
| « Coût manquant » | **Réutilisée verbatim** depuis `finance.products.table.costMissing` (Lot F2-bis) pour la carte "Valeur totale du stock" (`/produits?tab=stock`). | Même contrat "manquant ≠ zéro" (`unit_cost <= 0` = jamais saisi), même écran de risque (un chiffre faux affiché avec la confiance d'un total exact) — pas de raison de reformuler. Lot UX-CAT-01. |

## Décisions produit (Lot UX-CAT-01 — fiche client)

| Décision | Raison |
|---|---|
| Le score de fiabilité chiffré (0-100) n'est plus affiché en fiche/liste client. Seuls le palier (« Fiable »/« À surveiller »/« À risque »/« Nouveau client »), les faits vérifiables (commandes, livrées, refusées, annulées, montant livré) et les 3 signaux qualitatifs restent visibles. | Arbitrage du fondateur (session 2026-09-05, Lot UX-CAT-01) : « tout dépend du client » — un score opaque qu'il ne peut ni auditer ni expliquer va contre sa façon de décider. Ne pas réintroduire le chiffre sans une nouvelle décision explicite. |
| « Livré » scindé en deux libellés distincts sur la fiche client : « Livrées » (nombre de commandes, `stats.deliveredCount`) et « Montant livré » (somme en FCFA, `stats.delivered`). | Avant ce lot, `delivered_count` existait dans la RPC mais n'était jamais rendu — un seul libellé « Livré » sur le montant aurait été ambigu une fois le compte ajouté à côté. |

## Vocabulaire du domaine (Lot F2 — rentabilité par arrivage)

| Terme | Sens |
|---|---|
| Arrivage | Un lot d'achat fournisseur (`purchase_lot`) une fois reçu — le terme marchand pour ce que le code nomme `purchase_lot`/« lot ». Utilisé dans toute l'UI adressée au marchand (jamais « lot » seul, qui reste un terme de code). |
| Coût de revient rendu | Le coût unitaire atterri d'une ligne d'arrivage (`landedUnitCost`/`landed_unit_cost`) : prix d'achat + part de transport alloué, ramené à l'unité. Distinct du « prix d'achat » brut (avant transport) et du « coût de revient des vendus » (agrégat sur les seules unités vendues de l'arrivage, cf. `totals.costOfSoldMinor`). |

## Dette lexique — à statuer en U1

| Chaîne | Statut | Raison |
|---|---|---|
| « Données indisponibles » | **Tranché (UX-DS-01, 2026-09-04) : formulation générique conservée, aucune distinction par type d'erreur.** Un marchand qui voit « erreur serveur » plutôt que « droit insuffisant » ne fait rien de différent dans les deux cas — la donnée manque et il ne peut pas la produire lui-même ; distinguer les causes sert le développeur (déjà disponible via `logMetricLoadError`/Sentry), pas l'utilisateur. Exception potentielle non traitée ici : un droit insuffisant n'est pas une panne et devrait plutôt masquer le bloc que lui substituer ce message — mais `U0-D2` a déjà établi que le masquage par rôle fonctionne, le cas ne se présente donc pas en pratique. Valable pour tout écran futur affichant une erreur de chargement RPC, pas seulement le Tableau. |
| « Une erreur est survenue{,\|.} {r\|R}éessayez. » | **Tranché (UX-DS-01, 2026-09-04) : forme unique figée « Une erreur est survenue. Réessayez. » (point, pas virgule).** Trouvé fourché en deux variantes de ponctuation sur 14 clés `messages/fr.json` (8 avec virgule, 6 avec point), aucune des deux jamais consignée ici — la preuve directe qu'un terme employé sans entrée dérive. Le point est retenu (deux phrases complètes plutôt qu'une virgule de jonction, plus standard). Les 14 clés existantes + `assistant.feedback.errorBody` (violation de vouvoiement corrigée au même lot, autrefois « Réessaie ») unifiées sur cette forme. Toute nouvelle clé de message d'erreur générique doit réutiliser ce texte verbatim, jamais le reformuler. |

## Mécanismes conservés (à ne pas confondre avec les notions interdites)

Le retrait du « coût de reprise d'un colis refusé » ne retire **pas** le mécanisme de ligne
manquante de `ExplanationCard` (`components/ui/explanation-card.tsx`) — il reste nécessaire pour
d'autres coûts réellement pas encore connus au moment de l'affichage (ex. transport d'un
arrivage pas encore facturé, publicité pas encore saisie). Ce mécanisme est visible sur un écran
réel dans `purchase-lot-detail-panel.tsx` (« Marge provisoire — en attente de : … », formulation
figée ci-dessus).

## Écart vs solde (Lot CASH-01)

**« Écart » et « solde non remis » ne sont pas synonymes.** Un écart, c'est `attendu − reçu`
*après une remise* ; sans remise, il n'y a pas d'écart — seulement un solde (ce que le livreur
détient encore, en attente d'être remis). La carte « Cash chez le livreur (live) »
(`driver-cash-panel.tsx`) affichait un solde non nul en permanence comme « Écart non résolu »
en rouge (`text-danger`) : un marchand qui le voit tous les jours apprend à l'ignorer, et ne
verra pas un vrai écart le jour où il apparaît. **La bannière est retirée** (Lot CASH-01,
2026-09-01) — le solde reste visible via la carte elle-même, sans alarme de couleur. Le seul
endroit où le mot « écart »/« reste » peut légitimement apparaître est le récapitulatif de
confirmation d'un versement (`driver-remittance-form.tsx`, « Reste après la remise »), où il
compare une vraie action en cours (attendu vs. saisi) — jamais comme état permanent d'une carte.

## Gestion Shopify unifiée sous Paramètres > Boutiques (Lot SHOP-01)

`/boutiques` ne fait plus que rediriger vers `/parametres?tab=shops` (report de `connected`/
`error` uniquement). Les messages de retour OAuth (`settings.shops.messages.connected`,
`settings.shops.errors.*`) vivent désormais dans `SettingsShops`
(`components/settings/settings-shops.tsx`), pas dans l'ancien namespace `shops.*` de
`messages/fr.json` (réduit à `shops.banner`, seul reliquat encore référencé par
`ConnectShopBanner`, un composant déjà mort avant ce lot — laissé tel quel).

**Nouveau code d'erreur `unknown_client_id`** (émis par `callback/route.ts` quand le
`client_id` de la requête ne correspond à aucune app Shopify enregistrée) : « Cette
installation Shopify n'est pas reconnue. Contactez le support. » — même registre que les 6
autres codes déjà figés (impératif, pas de tutoiement, incite à réessayer ou contacter le
support). Un code émis par le serveur et absent de la liste reconnue retombe sur
`errors.generic`, jamais un silence ni le code brut affiché.

**Avertissement scope produit manquant, par boutique** (`reasons.productsScopeRequired` /
`productsScopeInstructions`, copie reprise verbatim de l'ancienne page) : distinct de
`reason === 'token_expired'` — un jeton valide peut manquer `read_products` (scope ajouté
après une première connexion). Les deux messages ne se substituent jamais l'un à l'autre.

## Statut « Connexion incomplète » (Lot APP-03)

Nouveau statut `ShopListItem.status === 'incomplete'` (`settings.shops.status.incomplete` /
`reasons.incomplete`) : une boutique `store_kind='shopify'`, `status='active'` mais sans
`access_token_encrypted` (rattachement embarqué en attente du token exchange, cf.
`app/api/shopify/embedded/session/route.ts`). Libellé retenu explicitement : **« Connexion
incomplète »**, jamais « en attente » — cet état ne distingue pas un parcours simplement
interrompu (l'utilisateur reviendra) d'un échange définitivement échoué ; « en attente » aurait
promis une résolution automatique non garantie. Distinct de `error` (jeton expiré, action de
reconnexion requise) et de `uninstalled` (déconnexion explicite) — ni erreur ni action utilisateur
attendue, juste un fait constaté. Jamais confondu avec `store_kind='manual'` (sans token par
conception, correctement affiché `connected`).

## Action « Libérer la boutique pour une nouvelle application Shopify » (Lot APP-03 correctif 3)

`settings.shops.release.*` — libellé imposé verbatim par le mandat, jamais reformulé. Visible
uniquement `owner`, uniquement sur une boutique `uninstalled` sans `shopify_client_id`/credential
resterait exploitable (`ShopListItem.canReleaseApp`, calculé côté lecture — la décision faisant
foi reste `decideAppRelease`, revérifiée à l'écriture, jamais présumée par la lecture seule).

Deux exigences de contenu non négociables dans `release.confirm` (avant toute confirmation) :
1. dire explicitement que l'opération **ne désinstalle pas** l'app côté Shopify — sinon un
   marchand pourrait croire l'action réversible via une simple réinstallation Shopify, alors que
   côté Shopify rien n'a changé ;
2. dire ce qui est **perdu** : les abonnements webhooks de l'ancienne app cessent de recevoir quoi
   que ce soit et devront être recréés pour la nouvelle — jamais seulement ce que l'opération ne
   fait pas, aussi ce qu'elle rend nécessaire ensuite.

Jamais de texte suggérant une bascule active→active (l'action n'existe que sur une boutique déjà
désinstallée — `decideShopAppSwitch`, lib/shopify/app-switch-guard.ts, reste la seule garde pour
une boutique encore active, et `release.action` ne s'affiche jamais dans ce cas). Vouvoiement,
comme le reste de `settings.shops.*`.

## Page de démonstration retirée (Lot F2-bis)

`app/(app)/dev/finance-foundations/page.tsx` (données 100 % fictives, hors navigation réelle) a
été supprimée une fois les écrans réels équivalents en place : la Fiche arrivage
(`purchase-lot-detail-panel.tsx`) et la vue arrivages de Finances (`app/(app)/finances/page.tsx`).
Les gardes qui s'appuyaient sur elle ont été reportées sur ces écrans réels :
- Absence de troncature monétaire (`[data-testid="amount"]`, aucun ancêtre `text-overflow: ellipsis`) : `tests/e2e/lot-f2-purchase-lot-detail.spec.ts`.
- Chiffres tabulaires (`Amount`, `tabular-nums`) : `tests/e2e/lot-u1f-tabular-nums.spec.ts`, désormais sur la Fiche arrivage.
- Contrat de fermeture de `DetailPanel` (croix/Échap/clic extérieur/focus, desktop et mobile) : `tests/e2e/detail-panel-close-contract.spec.ts`, désormais sur `ProductDetailPanel` (`/produits`).
- Vouvoiement sans exception : `tests/unit/ui/no-tutoiement-finance-components.test.ts`, liste mise à jour vers les écrans réels.

## Portée des versements sur `/livreurs` (Lot UX-VERS-01)

**« Tous livreurs confondus » est retiré.** La formulation datait d'avant `0133` : à l'époque,
la portée locataire était la seule possible, et « confondus » n'opposait donc rien. Depuis
`0133`, la même page filtre son **parc de livreurs** sur la boutique active (`getStoreDriverIds`)
alors que la liste des versements reste locataire — un livreur absent du parc pouvait apparaître
dans les versements sans que rien ne l'explique. Le sous-titre nomme désormais la portée :
« tous les livreurs du compte ».

**Ce n'est pas un défaut de portée, et il ne faut pas le « corriger ».** Le cash d'un livreur est
indivisible : un livreur sert réellement deux boutiques et remet une enveloppe unique (mesure
production consignée dans `0133`, lignes 30-32). `finance_kpis` laisse pour la même raison
`cash_chez_livreurs` cross-boutiques (`0064`, lignes 12-14). `cash_settlement`,
`settlement_allocation` et `settlement_shortfall` n'ont donc volontairement aucune colonne
`shop_id`, et n'ont pas à en recevoir : un versement qui couvre des commandes de deux boutiques
est un cas réel, sans bonne réponse.

**Indice conditionnel, jamais permanent** (`livreurs.settlements.scopeNoteAllShops`) : la mention
« toutes boutiques confondues » n'apparaît que si le compte possède plus d'une boutique — même
règle que `/finances`, qui n'affiche `kpis.cashDriversAllShops` que lorsqu'un filtre boutique est
actif. Un marchand mono-boutique ne lit pas une précision qui n'oppose rien chez lui. Décision
d'affichage isolée dans `lib/drivers/settlement-scope.ts` (module pur) et verrouillée par
`tests/unit/drivers/settlement-scope.test.ts`.

**Même règle sur `/finances`, carte « Livreurs concernés ».** Sa valeur vient de
`cash_aging(p_merchant)` (`0017`, ligne 183), qui n'a jamais eu de paramètre boutique : le
compteur est toujours locataire, exactement comme `cash_chez_livreurs` de la carte voisine. Cette
voisine basculait déjà sur `kpis.cashDriversAllShops` sous filtre boutique actif, « Livreurs
concernés » non — deux libellés contradictoires à un centimètre l'un de l'autre sur le même
écran. La variante `kpis.driversConcernedAllShopsTitle` applique désormais le même suffixe, au mot
près, sous la même condition. **Les deux surfaces partagent une seule décision d'affichage**
(`shouldShowTenantCashScopeNote`, contexte discriminé par surface) : elles se rétrécissent
différemment — `/livreurs` par son parc toujours filtré depuis `0133`, `/finances` par son
sélecteur `?shop=` — mais la règle « dire la portée seulement là où la vue environnante est plus
étroite que le chiffre » est unique et ne doit pas être réimplémentée par surface.

## Trois états de lecture distincts sur Paramètres > Boutiques (Lot FIX-WOO-01)

`settings.shops.woocommerce` porte désormais **trois microcopies mutuellement exclusives**, et la
distinction est une décision, pas une commodité d'implémentation :

| État | Chaîne | Ce qu'elle affirme |
|---|---|---|
| Lecture en cours | « Chargement des connexions WooCommerce… » (`loading`, `role="status"`) | rien n'est encore su |
| Succès réellement vide | « Aucune boutique WooCommerce connectée. » (`empty`) | **un fait confirmé** : la lecture a abouti et ne renvoie rien |
| Lecture échouée | « Vos connexions WooCommerce n'ont pas pu être chargées. Réessayez dans quelques instants. » (`errors.loadFailed`, `role="alert"` + bouton `actions.retryLoad` = « Réessayer ») | la lecture n'a pas abouti — l'état réel reste inconnu |

**Pourquoi cette entrée existe.** `listWooCommerceConnectionsAction` triait `store_connection` sur
une colonne inexistante (`updated_at`) : PostgREST répondait 400/42703, l'action renvoyait
`list_failed`, et le composant réduisait cet échec à `[]`/`false` — donc à la microcopie de l'état
vide. Le marchand lisait « Aucune boutique WooCommerce connectée » comme un **fait** alors que
rien n'avait été lu, et le parcours de première connexion restait inaccessible sans qu'aucun écran
ne le dise. Même contrat « manquant ≠ zéro » que « Coût manquant » et « Pas encore de CA encaissé
sur cet arrivage » : **un état inconnu ne doit jamais emprunter la formulation d'un état connu.**

**Règle générale, pas seulement WooCommerce** : un échec de lecture ne devient jamais `[]`, `null`
ou `false` avant de choisir une microcopie. Le message d'échec reste générique et externe — aucun
code SQL, aucun nom de colonne, aucun détail de requête n'est adressé au marchand (l'action ne
renvoie déjà qu'un code opaque). « Réessayer » désigne la reprise d'une **lecture** échouée ;
« Reprendre » (`actions.retry`) reste réservé à la reprise d'un **provisionnement ou d'une
synchronisation** — les deux ne doivent pas être fusionnés.

## Retrait de l'action « Refuser par le client » (Lot FIX-UI-REFUS-01)

**Deux libellés d'ACTION retirés, un libellé de STATUT conservé — la distinction est la
décision, pas un détail d'implémentation.**

| Chaîne | Statut | Raison |
|---|---|---|
| « Refuser par le client » (entrée de menu, file d'appel) | **Retirée.** | Le geste n'existe plus dans l'interface. Le cas métier est couvert par « Annuler la commande » avant la livraison et « Marquer retournée » après — ce lot ne crée aucun statut de remplacement. |
| « Refuser » (même action, autres stades) | **Retirée.** | Même action (`refuser`), second libellé selon le contexte. Les deux partent ensemble : n'en retirer qu'un aurait laissé le geste atteignable sous l'autre nom. |
| « Refusée » (`orderStatusLabels.REFUSEE`, `orders.codStatus.REFUSEE`, `finance.status.REFUSEE`, `CodStatusBadge`) | **Conservée — ne pas retirer.** | C'est le nom du STATUT, pas de l'action. Une commande historique dans cet état doit continuer d'afficher un nom lisible, jamais la valeur brute `REFUSEE` ni un vide. « Marquer retournée » vise toujours ce statut, et les surfaces de refus/RTO (`Taux de refus / RTO`, « Refuseurs répétés ») restent inchangées. |

**Message de refus d'un appel direct** (`RETIRED_ACTION_MESSAGES.refuser`,
`lib/actions/transitions.ts`, code `action_retired`) : « L'action « Refuser par le client »
n'existe plus. Utilisez « Annuler la commande » avant la livraison, ou « Marquer retournée »
après une livraison. » Il **nomme le remplacement** : un utilisateur qui l'obtient (session
ouverte avant le déploiement, raccourci mémorisé) serait sinon laissé sans issue. Vouvoiement,
comme le reste. Ce code est distinct de `forbidden` (droits) et d'`illegal_transition` (l'état
ne permet pas) : ni l'un ni l'autre ne serait factuellement vrai ici.

**Ne pas « réparer » en remettant l'entrée au menu.** Le retrait est posé une seule fois, dans
`retiredTransitionActions` (`lib/domain/order-transition-actions.ts`) : la machine à états, le
CHECK de `cod_status` et la RPC `transition_order` sont intacts, et les commandes déjà en
REFUSEE gardent leur sortie (« Désannuler »).

## Libellés qui annonçaient une portée fausse (Lot COHERENCE-01)

**Dix libellés corrigés, aucun calcul touché.** La règle commune : un libellé qui annonce une
fenêtre, un axe de date ou un périmètre doit annoncer **celui que le code applique réellement**.
Quand le calcul est juste et le nom faux, c'est le nom qui bouge — jamais le calcul. Chaque ligne
ci-dessous a été mesurée au catalogue, pas déduite du texte d'une migration
(voir `docs/lexique-dates.md`).

| Clé | Avant | Après | Pourquoi |
|---|---|---|---|
| `tableau.blocks.exceptions.rows.enLivraison` | « En cours de livraison (7 j) » | « En cours de livraison » | `get_dashboard_priority_counts` ne porte de fenêtre que sur sa branche `a_appeler` depuis `0149`. Le « (7 j) » était une **contradiction factuelle** : la fenêtre a été retirée parce qu'elle masquait 83 % de la population en production. |
| `tableau.blocks.exceptions.rows.annuleesRetours` | « Annulées / Retours (7 j) » | « Annulées / Retours » | Même cas, même migration (masquait 93 %). |
| `tableau.kpi.delta_hier` | « vs hier » | « vs 7 j précédents » | `get_dashboard_kpi` compare J-14→J-7 à J-7→J0 depuis `0076`, jamais la veille. **Clé actuellement non consommée** : `DeltaChip` (`components/kpi/KPICard.tsx`) ne rend qu'une flèche et un nombre, aucun texte de comparaison. La correction est donc **préventive** — elle empêche de câbler la phrase fausse plus tard — et **n'est pas un changement visible**. Ne pas la présenter comme tel. |
| `tableau.kpi.taux_livraison` | « Taux livraison » | « Taux livraison (tout l'historique) » | La carte n'a **aucune** fenêtre (`0076`:109-136) et siège dans la même bande qu'« À appeler (7 j) » : sans la portée, rien ne distingue les deux. |
| `tableau.kpi.taux_confirmation` | « Taux confirmation » | « Taux confirmation (30 j) » | Dénominateur borné à 30 jours (`0076`:92-107). Par symétrie avec « À appeler (7 j) ». |
| `tableau.blocks.shopPerformance.amount` | *(colonne monétaire sans aucun libellé)* | « Montant commandé » | `get_dashboard_shop_performance` (`0129`:35) rend `sum(o.total_amount)` sur `created_at`, **sans aucun filtre de statut** : une commande annulée y contribue. **Jamais « CA ».** Le champ reste nommé `revenue` — c'est le nom rendu par la RPC **et** le champ TS (`lib/actions/dashboard.ts`:59) ; le renommer déclencherait une migration pour un mot. **On corrige le libellé affiché, pas le champ.** |
| `livreurs.cash.collectedTotal` | « Collecté sur période » | « Collecté sur les commandes de la période » | `get_driver_cash_consolidation` (`0100`:103-112) borne sur **`orders.created_at`**, jamais `cash_collected_at`. L'axe est une décision datée et assumée (`0100`:17-24) ; c'est donc le libellé qui doit le dire. |
| `livreurs.cash.cashOnHandPeriodDefinition` | avertissait de l'écart avec le solde live | + « le terme « collecté » est daté sur la date de CRÉATION de la commande » | La définition disait déjà qu'un versement peut couvrir des commandes hors période. Elle **ne disait pas** l'information qui manquait vraiment : du cash encaissé pendant la période est invisible si la commande est plus ancienne. |
| `tableau.blocks.operationsEssentials.cancellationRateScope` | *(rien)* | « Sur les commandes créées dans la période, même sans issue » | Cohorte immature : le dénominateur inclut les commandes créées aujourd'hui qui n'ont encore aucune issue. Posé dans le `hint` (slot existant, même usage que `periodHint`), pas dans le libellé, pour ne pas déséquilibrer la grille. **Aucun indicateur de maturité n'a été ajouté** — celui du graphe voisin (`isMature`) est une fonctionnalité, pas une microcopie. |
| `report.statusSubtitle` (PDF) | *(rien)* | « Commandes créées sur la période · montant commandé, jamais le CA encaissé » | `get_report_status_breakdown` (`0085`:104-116) rend un montant **légitime** sur `created_at` que `0119` a explicitement préservé. Le problème est de **cohabitation** : il se lit à deux centimètres du KPI « Chiffre d'affaires » de la même page, daté `cash_collected_at`, et les deux ne coïncident jamais. On nomme la section et la colonne, on ne touche pas le calcul. |

**Ce qui n'a PAS été corrigé par un libellé, et pourquoi.** « Produits les plus vendus »
(Tableau) et `get_top_products` (assistant) portaient un montant daté sur `created_at`, avec un
périmètre incluant `CONFIRMEE`/`PROGRAMMEE`/`EN_LIVRAISON` — donc des commandes ni livrées ni
payées. **Ce libellé ne se corrige pas** : le bloc doublait « CA par produit », qui répond à la
même question et est juste. Les deux sont **retirés**, pas renommés. « Top produits » du rapport
PDF (`get_report_top_products`, `0086`) est le même défaut **en pire** (aucun filtre de statut) et
**reste en place** : un doublon retiré d'un écran et conservé dans un document est un écart, pas
une clôture — il est nommé comme tel dans `docs/lexique-dates.md` §6.

**Règle à retenir pour la suite.** Avant d'écrire « (7 j) », « sur période », « CA » ou
« vendus » dans un libellé, vérifier au catalogue ce que la source applique réellement. Les
libellés sont la première cause d'impression fausse chez le marchand, **avant** les calculs —
et ils coûtent le moins cher à corriger.

## Domaine affiché dans les contenus publics (FIX-LANDING-DOMAIN-01, 2026-09-20)

| Chaîne | Statut | Raison |
|---|---|---|
| `marketing.mock.url` — « www.teerafrik.com/commandes » | **Formulation figée.** La barre d'adresse factice de la maquette d'accueil (`components/marketing/cockpit-mock.tsx`) affiche le **domaine public de la marque**, jamais un domaine de déploiement. | Elle affichait « teer-dev.vercel.app/commandes » — le domaine de projet Vercel — à tout visiteur de la page d'accueil. Aucun défaut de fonctionnement : c'est une chaîne codée en dur dans `messages/fr.json`, sans rapport avec `NEXT_PUBLIC_APP_URL`, et elle a survécu à la correction de cette variable. Le coût est de crédibilité — un produit qui montre son URL interne dans sa propre vitrine se présente comme inachevé. **Règle générale : aucune chaîne de `messages/fr.json` ne doit porter un domaine de déploiement** (`*.vercel.app`, URL de prévisualisation, domaine de projet). Vérifié au lot : c'était la seule occurrence dans l'ensemble des contenus publics (`messages/`, `app/`, `components/`, `public/`, `docs/legal/`). |

## Récupération de mot de passe (PWD-RESET-01, 2026-09-19)

Le parcours n'existait pas ; la FAQ le promettait depuis des mois. Les décisions ci-dessous
portent sur ce que l'interface **dit**, et deux d'entre elles sont des interdictions.

| Chaîne / notion | Décision | Raison |
|---|---|---|
| « Mot de passe oublié ? » | **Libellé figé** du lien sur `/connexion` (mode connexion uniquement) et de l'entrée FAQ `equipe-mot-de-passe`. Le point d'interrogation fait partie du libellé. | La FAQ promettait « Mot de passe oublié » sans point d'interrogation, pour un lien qui n'existait pas. Les deux doivent désormais coïncider mot pour mot — une FAQ qui décrit un parcours légèrement différent est une nouvelle promesse fausse, en plus petit. |
| **Toute durée chiffrée de validité du lien** | **Interdit à l'affichage, sans condition et sans échéance.** L'interface écrit « Ce lien expirera prochainement. », jamais un nombre — de même que la FAQ, qui dit « au bout d'un moment ». | **Le TTL de production A ÉTÉ mesuré : `3600` secondes, relevé dans le tableau de bord Supabase le 2026-09-19** (la pile locale porte la même valeur, `GOTRUE_MAILER_OTP_EXP=3600`). **Le connaître ne le rend pas affichable, et cette entrée ne prévoit aucun cas où il le deviendrait.** La durée reste volontairement générique pour ne pas coupler la microcopie à une configuration externe : le réglage vit dans le tableau de bord Supabase, peut changer sans toucher au dépôt, et tout nombre affiché créerait une dette de synchronisation entre Supabase, l'interface et la documentation — une promesse fausse le jour où les deux divergent. La FAQ annonçait autrefois une durée chiffrée sans l'avoir mesurée ; c'est ce défaut-là qui a été fermé, pas seulement son inexactitude. Décision du fondateur (lot DOC-PWD-RESET-01, 2026-09-19). |
| « Si un compte Tëër existe pour {email}, vous y recevrez un lien pour choisir un nouveau mot de passe. » | **Formulation figée** de l'accusé de réception. Le conditionnel est obligatoire. | L'écran doit être **identique** que l'adresse existe ou non. Écrire « Nous avons envoyé un lien à {email} » affirmerait l'existence du compte : c'est une énumération d'adresses par microcopie, et elle serait vraie même avec un serveur parfaitement silencieux. |
| « Ce lien est invalide, expiré ou a déjà été utilisé. Demandez un nouveau lien. » | **Message unique** pour les trois cas, affiché sur `/connexion?reason=lien_invalide`. **Ne pas le scinder en trois messages.** | Mesuré le 2026-09-19 : GoTrue rend exactement `error=access_denied` + `error_code=otp_expired` + « Email link is invalid or has expired » pour un jeton **expiré**, **rejoué** et **inexistant**. Les trois sont indistinguables à la source. Promettre trois messages distincts obligerait à inventer une distinction que la plateforme ne fournit pas. |
| Message distinct de **panne du fournisseur** | **Interdit.** Un échec d'envoi (Resend, SMTP, Supabase) part dans Sentry et rend la **même** réponse neutre. | Un message technique différencié révélerait qu'une tentative d'envoi a eu lieu, donc que le compte existe. La panne doit être visible pour nous, jamais pour le public. |
| « Trop de demandes depuis cet appareil. Patientez avant de réessayer. » | **Seul** cas annoncé distinctement sur l'écran de demande. | C'est la limitation **locale par IP** (Upstash, 5/heure), qui ne dépend d'aucun compte — l'annoncer ne révèle rien. À ne pas confondre avec l'intervalle de 26 s de Supabase, qui est **par utilisateur** et reste volontairement avalé dans la réponse neutre. |
| « Adresse e-mail invalide. » | **Autorisé** (clé existante `auth.errors.invalid_email`). | Validation de **format**, jamais d'existence. C'est l'existence de l'adresse qui doit rester indistinguable, jamais sa syntaxe. |
| « Par sécurité, vos autres appareils connectés seront déconnectés. » | **Formulation figée**, affichée avant l'enregistrement du nouveau mot de passe. | Comportement **mesuré**, pas supposé : après la mise à jour, les sessions antérieures rendent 403 et leurs jetons de rafraîchissement 400, tandis que la session courante survit. L'annoncer évite que le marchand découvre seul qu'il est déconnecté ailleurs — et c'est la vraie mitigation d'un lien intercepté : l'accès devient **détectable**. |

**Registre.** L'entrée FAQ `equipe-mot-de-passe` était rédigée au tutoiement (« clique », « tu
recevras », « va dans ») en violation de la règle de vouvoiement ci-dessus. Elle est réécrite au
vouvoiement dans ce lot, parce qu'elle était de toute façon réécrite — et non au titre d'une
passe de correction du reste de la FAQ, qui en compte d'autres et relève d'un lot dédié.

## Refus de bascule d'app sur le callback OAuth (Lot SEC-APP-SWITCH-01, 2026-09-20)

`settings.shops.errors.app_switch_refused` — **huitième** code OAuth de
`components/settings/settings-shops.tsx`, émis par `app/api/shopify/callback/route.ts` quand une
installation vise une boutique du **même locataire** déjà rattachée à une **autre** application
Tëër. Il complète l'entrée « Libérer la boutique… » ci-dessus : celle-ci décrit la sortie, celui-ci
est le mur que le marchand rencontre d'abord.

**Le texte nomme TROIS étapes, et l'ordre est le fond, pas la forme :**

1. désinstaller l'ancienne application **depuis l'administration Shopify** ;
2. libérer la boutique dans **Paramètres → Boutiques** ;
3. recommencer l'installation.

**Pourquoi la première étape ne peut pas être omise — c'est une mesure, pas une précaution de
style.** L'action « Libérer la boutique… » n'est **affichée** que si
`status === 'uninstalled' && shopify_client_id && !access_token_encrypted && !refresh_token_encrypted`
(`ShopListItem.canReleaseApp`, `lib/actions/shops.ts:130-134`), et `decideAppRelease` refuse sinon
(`shop_still_active`, `credential_present` — `lib/shopify/app-release-guard.ts:73-79`). Or ce
refus survient précisément quand l'ancienne app est **encore installée**. Une microcopie qui
enverrait directement vers Paramètres → Boutiques désignerait donc, dans le cas le plus fréquent,
un bouton **que le marchand ne voit pas**. C'est l'état `uninstalled` posé par le webhook
`app/uninstalled` (`lib/shopify/webhook-core.ts:704-717` : statut et jetons) qui le fait
apparaître.

**Libellé du chemin, vérifié mot pour mot** : « Paramètres » (`settings.title`) → « Boutiques »
(`settings.tabs.shops`). Ne pas écrire « Réglages », ni « Mes boutiques ».

**Ce que le message ne dit jamais**, et ce n'est pas négociable : ni le `client_id`, ni le nom
interne de l'application historique (`teer-dev`, `teer-koba`…), ni le locataire, ni le domaine.
Seul le code `app_switch_refused` transite par l'URL de redirection ; l'identité de l'application
en place reste une information interne, portée par la seule sentinelle Sentry
`SHOPIFY_APP_SWITCH_REFUSED`. Même discipline que la surface embarquée, qui refuse déjà de nommer
l'app historique (`app/api/shopify/embedded/session/route.ts`).

**Renvoi au propriétaire, et pourquoi il est dans le texte** : la libération est réservée au rôle
`owner` (`requireRole('owner')`, `lib/actions/shops.ts:209` ; `REQUIRED_ROLE`,
`lib/shopify/app-release-guard.ts:45`). Un `manager` qui lance l'installation reçoit ce refus et
n'a aucun moyen de le lever lui-même — le lui taire le laisserait tourner en rond.

**Ce refus reste distinct de `connection_failed`, ne pas les fusionner.** Le refus nommé n'est
émis que par la garde **préalable**, sur un état **lu et mesuré** avant tout échange de code. Une
écriture qui échoue ensuite sur son compare-and-set rend zéro ligne, et zéro ligne n'a pas de
cause attribuable (application changée, propriété réassignée, ligne supprimée) : elle retombe
donc sur `connection_failed`, jamais sur `app_switch_refused`. Étiqueter ce second cas
affirmerait une cause que rien n'a établie.

Vouvoiement, comme tout `settings.shops.*`.
