# Mesure de production — jetons Shopify expirants (2026-09-26)

Labels : `[Fait]` mesuré ou lu ; `[Décision]` arbitrage consigné ; `[Non vérifié]` non établi.

## Mesure réelle du rafraîchissement

`[Fait]` Le 2026-09-25, lors de l'installation de `teer-public` (app déclarée `public`), l'échange de code a émis un access token d'une durée de **3600 s** et un refresh token de **90 jours**.

`[Fait]` En production le 2026-09-26, sur `teer-public-smoke.myshopify.com`, le cron `shopify-reconcile` de 02:00 a émis un jeton vers **02:03 UTC**, avec échéance vers **03:03**. Aucun rafraîchissement n'a été observé entre 03:03 et 14:50.

`[Fait]` À 14:50, un humain a cliqué « Synchroniser » dans `/parametres`. Le bail a été acquis à **14:50:54.582**, génération **4** ; `shopify.products_synced` a été journalisé à **14:50:55.308**, puis `shop_synced` à **14:50:55.688**. La nouvelle échéance de l'access token était à **+1 h**, celle du refresh token à **+90 jours** ; l'empreinte de l'access token avait changé, le bail avait été libéré et `store_connection` était cohérent.

`[Décision]` Cette mesure établit le fonctionnement de bout en bout du chemin de rafraîchissement en production : détection, acquisition du bail, appel Shopify, rotation des deux jetons, écriture fencée et libération.

## Limite de l'observation du statut

`[Décision]` Cette mesure n'établit pas que `shopStatus` a rendu « Connectée » en évaluant une ligne dont l'access token était encore échu. La capture de `/parametres` montrant ce statut a été prise après le clic ; l'audit horodate le rafraîchissement à 14:50:54.582, avant le calcul du statut sur la ligne réécrite. Personne n'a ouvert la page entre 03:03 et 14:50.

`[Fait]` `/parametres` appelle `listShopsAction` (`components/settings/settings-shops.tsx:105-109`, `lib/actions/shops.ts:92`). L'action lit les données de `shop`, puis calcule le statut en mémoire ; cette lecture n'effectue aucun appel sortant Shopify. Le rafraîchissement survient au premier usage réel du jeton, jamais à la simple lecture de la page.

`[Décision]` Les tests unitaires 7 et 8 de `tests/unit/shopify-shop-status.test.ts` et la lecture de `lib/shopify/shop-status.ts` établissent que le statut reste « Connectée » lorsque l'access token est échu mais que le refresh token est encore valable, et devient une erreur si le refresh token est lui-même échu. Le comportement attendu entre 03:03 et 14:50 est donc cohérent avec les tests et le code, mais reste une **déduction**, pas une observation de production. Ne pas écrire que le statut a été observé « connecté malgré un jeton échu au moment du calcul ».

`[Décision]` Le correctif de `shopStatus` est nécessaire parce qu'une boutique peut légitimement porter un access token échu entre deux usages. Les onze heures mesurées le 26 septembre en sont la démonstration : avant ce correctif, la page aurait affiché une erreur alors que le rafraîchissement fonctionnait au prochain usage.

`[Décision]` Ne tirer aucune propriété architecturale de `/parametres` : ni latence, ni disponibilité, ni volume de rafraîchissements lié au trafic. Le code établit seulement que cette lecture ne rafraîchit pas les jetons.

## Microcopie de déconnexion — constat, non corrigé

`[Fait]` L'action actuelle est libellée « Déconnecter » et sa confirmation est « Déconnecter cette boutique de Tëër ? » (`components/settings/settings-shops.tsx:170-178`, `messages/fr.json:744-747`). Elle ne dit pas qu'une nouvelle autorisation Shopify sera nécessaire.

`[Fait]` La déconnexion efface les credentials ; reconnecter la boutique exige donc un nouvel OAuth. C'est intentionnel : conserver un jeton valide en base après déconnexion était un défaut.

`[Décision]` La microcopie n'est pas corrigée dans ce lot. Sa mise à jour est une dette UI ouverte dans `CLAUDE.md`.
