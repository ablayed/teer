# L03 — Région d'exécution Vercel : `iad1` → `fra1`

Lot du programme performance d'octobre 2026. Changement de configuration, sans code.

## Ce qui a changé

`[Rapporté, porteur, 2026-10-09]` La région d'exécution des fonctions du projet Vercel est passée
de `iad1` (Washington, D.C.) à `fra1` (Francfort), puis le projet a été redéployé. Le réglage a
été fait par le porteur dans les paramètres du projet Vercel.

`[Rapporté, porteur]` Supabase et Upstash sont en `eu-central-1` (Francfort). Avant le changement,
chaque aller-retour entre une fonction et la base traversait l'Atlantique ; après, la fonction et
ses deux dépendances sont dans la même ville.

`[Fait]` Rien n'a changé dans le dépôt. `vercel.json` ne déclare aucune région (il ne porte que
les trois tâches planifiées), et aucun `next.config` n'en fixe. Une seule route en nommait déjà
une avant ce lot : `app/api/assistant/chat/route.ts:12` (`preferredRegion = 'fra1'`).

## Mesures

`[Rapporté, porteur]` TTFB du document, Chrome, cache désactivé, depuis le Royaume-Uni, trois
essais par écran, avant puis après le changement.

| Écran | Avant (`iad1`) | Après (`fra1`) | Médiane avant | Médiane après | Écart |
| --- | --- | --- | --- | --- | --- |
| Commandes | 2,60 s · 2,60 s · 2,49 s | 1,09 s · 1,08 s · 1,06 s | 2,60 s | 1,08 s | −1,52 s (−58 %) |
| Tableau | 1,32 s · 1,07 s · 1,06 s | 0,72 s · 0,46 s · 0,44 s | 1,07 s | 0,46 s | −0,61 s (−57 %) |

Les médianes et les écarts sont calculés à partir des trois essais rapportés.

## Lecture

- L'écart est du même ordre sur les deux écrans, en proportion. C'est cohérent avec un coût payé
  à chaque aller-retour vers la base, plus élevé sur l'écran qui en fait le plus.
- `[Non vérifié]` La part exacte du gain due aux allers-retours vers la base, à Upstash ou au
  trajet entre le navigateur et la fonction : le TTFB les additionne, aucune décomposition n'a
  été faite (pas d'en-tête `Server-Timing`, pas de trace).
- Le premier essai du Tableau est le plus lent des trois, avant comme après (1,32 s, 0,72 s). Un
  démarrage à froid est plausible, non établi.

## Limites

1. **Trois essais par écran**, un seul poste, un seul navigateur. C'est un ordre de grandeur, pas
   une distribution.
2. **Mesuré depuis le Royaume-Uni.** Les marchands sont en Afrique de l'Ouest. Le trajet entre le
   navigateur et la fonction n'est pas le même depuis Dakar ; le gain réel pour eux n'est pas
   mesuré. Seule la partie « fonction ↔ base » du gain est indépendante du lieu de mesure.
3. **L'agent n'a rien mesuré.** Ces chiffres sont ceux du porteur ; l'agent n'a accès ni au projet
   Vercel, ni à la production.
4. **Le réglage vit hors du dépôt.** Il n'est ni versionné ni relu : un projet Vercel recréé, ou
   un réglage remis par défaut, ramène `iad1` sans qu'aucun contrôle ne le signale. Le fixer dans
   `vercel.json` fermerait cet écart ; ce n'est pas fait, par décision du porteur pour ce lot.
5. `[Non vérifié]` Que toutes les fonctions s'exécutent bien en `fra1` après le redéploiement
   (routes d'API, tâches planifiées, webhooks). La mesure porte sur deux pages.
6. `[Non vérifié]` L'effet sur les appels sortants vers Shopify, dont les serveurs ne sont pas en
   Europe : un import ou une réconciliation peut avoir perdu sur ce trajet ce qu'il gagne vers la
   base. Non mesuré.

## Suite

Les seuils de budget de l'import (tâche planifiée de 300 s) avaient été estimés avec une latence
ajoutée par aller-retour. Ils sont à réévaluer en production maintenant que la fonction et la
base sont dans la même région, sans promesse tirée de ces trois essais.
