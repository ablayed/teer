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
