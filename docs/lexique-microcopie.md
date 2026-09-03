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

## Vocabulaire du domaine (Lot F2 — rentabilité par arrivage)

| Terme | Sens |
|---|---|
| Arrivage | Un lot d'achat fournisseur (`purchase_lot`) une fois reçu — le terme marchand pour ce que le code nomme `purchase_lot`/« lot ». Utilisé dans toute l'UI adressée au marchand (jamais « lot » seul, qui reste un terme de code). |
| Coût de revient rendu | Le coût unitaire atterri d'une ligne d'arrivage (`landedUnitCost`/`landed_unit_cost`) : prix d'achat + part de transport alloué, ramené à l'unité. Distinct du « prix d'achat » brut (avant transport) et du « coût de revient des vendus » (agrégat sur les seules unités vendues de l'arrivage, cf. `totals.costOfSoldMinor`). |

## Dette lexique — à statuer en U1

| Chaîne | Statut | Raison |
|---|---|---|
| « Données indisponibles » | **Dette, pas encore une formulation figée.** Utilisée depuis Lot TB-P0 sur 8 blocs du Tableau (`tableau.dataUnavailable` dans `messages/fr.json`, réutilisant verbatim le texte déjà présent à `tableau.kpi.unavailable`) pour tout état d'erreur RPC. Aucune entrée de ce lexique ne la couvrait avant TB-P0 ; ce lot ne tranche volontairement rien (registre déjà conforme — vouvoiement non concerné, pas de pronom), il documente seulement l'usage. À examiner en U1 : est-ce la bonne formulation pour tout écran futur affichant une erreur de chargement (au-delà du Tableau), ou faut-il distinguer erreur réseau / erreur serveur / droit insuffisant sous des libellés différents ? |

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

## Page de démonstration retirée (Lot F2-bis)

`app/(app)/dev/finance-foundations/page.tsx` (données 100 % fictives, hors navigation réelle) a
été supprimée une fois les écrans réels équivalents en place : la Fiche arrivage
(`purchase-lot-detail-panel.tsx`) et la vue arrivages de Finances (`app/(app)/finances/page.tsx`).
Les gardes qui s'appuyaient sur elle ont été reportées sur ces écrans réels :
- Absence de troncature monétaire (`[data-testid="amount"]`, aucun ancêtre `text-overflow: ellipsis`) : `tests/e2e/lot-f2-purchase-lot-detail.spec.ts`.
- Chiffres tabulaires (`Amount`, `tabular-nums`) : `tests/e2e/lot-u1f-tabular-nums.spec.ts`, désormais sur la Fiche arrivage.
- Contrat de fermeture de `DetailPanel` (croix/Échap/clic extérieur/focus, desktop et mobile) : `tests/e2e/detail-panel-close-contract.spec.ts`, désormais sur `ProductDetailPanel` (`/produits`).
- Vouvoiement sans exception : `tests/unit/ui/no-tutoiement-finance-components.test.ts`, liste mise à jour vers les écrans réels.
