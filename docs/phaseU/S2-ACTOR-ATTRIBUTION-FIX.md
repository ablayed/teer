# S2 — Fermeture de la falsification d'attribution sur `transition_order`

## Verdict

**Correctif écrit, corrigé une fois avant preuve finale (garde rendue NULL-safe, attribution dérivée de `v_actor` en défense en profondeur — §1), prouvé localement par CINQ scénarios (rouge avant / vert après / `p_actor` NULL explicite / contrôle positif / sans session), diff mécanique réel de `pg_get_functiondef` conforme à la prédiction exacte, intégrité d'ACL confirmée inchangée. Arrêt obligatoire respecté : aucun `db push`, aucun `db:types`, aucune base distante touchée.**

**Conséquence directe de `0148` (§5bis) : deux tests existants appelaient `transition_order` en service-role sans session — un raccourci qui n'existe pour aucun appelant de production. Les deux ont été corrigés (routage vers une session réelle), et la causation par `0148` est vérifiée empiriquement pour chacun (rouge avant / vert après mesurés, pas seulement affirmés par analogie) : `tests/rls/customer-reliability-projection.rls.test.ts` (30/30 vert) et `tests/e2e/finances.spec.ts` (rejoué isolément — rouge avant : `42501 forbidden` sur le code original ; vert après : `1 passed (18.2s)` avec le correctif).** Un échec pré-existant sans rapport, `tests/rls/shopify-refund-shop-scoped-order-resolution.rls.test.ts` (import-time, `RESEND_API_KEY` absent localement), est confirmé purement local — la CI le couvre déjà avec une valeur synthétique dédiée.

Reste à faire, **hors de ce lot, étape humaine séparée** : le fondateur exécute `pnpm exec supabase db push`, relève l'ACL de production, et fait un smoke test PostgREST sur le chemin applicatif réel (`lib/actions/transitions.ts`).

---

## 0. Rappel — ce qui était déjà prouvé (S2-D, non refait ici)

| Fait | Référence |
|---|---|
| Attribution falsifiable | `docs/phaseU/S2-D-ACTOR-ATTRIBUTION.md` §2 — reproduction locale, session de A, `p_actor` = B, `order_state_transition.actor_user_id` porte B |
| Atteignable en production | `docs/phaseU/S2-D-ACTOR-ATTRIBUTION.md` §1 — `authenticated` a `EXECUTE`, `anon` non |
| Cause | `0145_lotF1_finances_v2_socle.sql:602-851` — `p_actor` jamais confronté à `auth.uid()` |
| Seul appelant réel | `lib/actions/transitions.ts:404-405`, client cookie-based clé anon, session validée par `getUser()`, `auth.uid()` non nul, `p_actor = ctx.user.id` déjà |

---

## 1. Migration `0148`

`supabase/migrations/0148_transition_order_actor_attribution_guard.sql` — `create or replace function public.transition_order(...)`, signature strictement identique à `0145` (vingt arguments, mêmes noms/types/ordre/défauts). Corps repris de `0145`, avec une déclaration (`v_actor uuid`), un bloc de garde **NULL-safe** ajouté juste après `begin` (avant tout accès à `public.orders`), et la substitution `p_actor` → `v_actor` dans les seules écritures d'attribution :

```sql
v_actor := auth.uid();

if v_actor is null or p_actor is distinct from v_actor then
  raise exception 'forbidden'
    using errcode = '42501';
end if;
```

**Correction apportée avant preuve finale** : la première version de ce garde utilisait `p_actor <> v_actor` (opérateur `<>` classique). Défaut trouvé par relecture avant exécution des preuves : `p_actor <> v_actor` vaut `NULL` (pas `TRUE`) dès que `p_actor` est explicitement `NULL` — un `if NULL then` ne s'exécute pas, la garde aurait laissé passer une session valide avec `p_actor = null` explicite, effaçant l'attribution plutôt que de l'usurper. Corrigé en `is distinct from`, NULL-safe des deux côtés — même famille de gotcha que les gardes de rôle `SECURITY DEFINER` déjà documentées dans `CLAUDE.md` (`NULL not in (...)` n'est pas `TRUE`), même forme que la garde de `0147` (`current_shop_role(...) is distinct from 'owner'`).

**Défense en profondeur** : les quatre écritures directes d'attribution (`order_state_transition.actor_user_id`, deux insertions `purchase_lot_line_allocation.created_by`, `cash_settlement.created_by`) et les huit appels `private.post_stock_movement(p_created_by := ...)` utilisent désormais `v_actor`, jamais `p_actor`. Aucun changement de comportement — après la garde, les deux valeurs sont égales par construction — mais l'attribution devient structurellement dérivée de la session, pas seulement protégée par la présence de la garde en amont. `p_actor` reste dans la signature (aucun changement de signature) et n'est plus lu nulle part ailleurs que dans cette comparaison initiale. Douze substitutions au total, confirmées par diff mécanique (§4.a).

Mêmes variable/code/errcode que le garde-fou déjà en place sur `private.post_stock_movement` depuis `0136` (`v_actor := auth.uid(); ... if p_created_by <> v_actor then raise exception 'forbidden' using errcode = '42501'`) — `transition_order` appelait le cœur privé directement et contournait cette garde ; ce lot porte le même contrôle, au même endroit dans le flux.

`security invoker` / `volatile` / `parallel unsafe` / `search_path=''` réaffirmés explicitement dans le `create or replace` (non préservés automatiquement par Postgres). Aucun `revoke`/`grant` : signature identique, l'ACL existante est préservée automatiquement (règle du projet — ne s'applique qu'à un `CREATE FUNCTION` plein ou un changement de signature), confirmé par mesure ci-dessous.

Échec bruyant, jamais correction silencieuse : `p_actor` divergent (y compris `NULL`) → refus, jamais réécrit. `auth.uid()` nul → refus également (aucun appelant système n'existe aujourd'hui, cf. inventaire S2-D §3).

**Code `'forbidden'` non mappé côté TypeScript, décision assumée, pas une omission.** `lib/actions/transitions.ts:60-89` (`TransitionErrorCode`/`dateBoundErrorMessages`) ne contient aucune entrée `forbidden` distincte de ce nom — un refus SQL `'forbidden'` retombe donc sur le message générique `update_failed` (« Vérifiez vos droits puis réessayez »), exactement comme les deux autres gardes de défense en profondeur déjà non mappées (`driver_not_in_store`, `order_store_conflict` quand elles sont interceptées en amont côté TS). Le chemin est inatteignable pour un appelant légitime — le seul appelant réel envoie toujours `p_actor = ctx.user.id = auth.uid()` — donc aucun utilisateur ne verra jamais ce message. Aucune correction TypeScript appliquée dans ce lot.

Aucun nouveau code d'erreur ajouté côté TypeScript : `'forbidden'` ne matche aucune des 4 clés de `dateBoundErrorMessages` (`lib/actions/transitions.ts:60-75`) et retombe donc, comme `driver_not_in_store`/`order_store_conflict` (autres gardes de défense en profondeur déjà couvertes côté TS avant l'appel RPC), sur le message générique `update_failed` — comportement déjà en place, aucune modification TypeScript nécessaire pour ce lot.

---

## 2. Les cinq preuves, dans l'ordre

Toutes via **PostgREST direct**, jamais un appel SQL brut ni un chemin applicatif — méthode identique à S2-D. Transition utilisée : `livrer` (confirmer → programmer → dispatch → livrer, `p_delivery_state='delivered'`, `p_cash_state='collected'`), qui exerce l'allocation FIFO (`0145`) et le mouvement de stock `sold`. Fixtures : deux tenants réels (A propriétaire de la boutique/commande, B un utilisateur totalement étranger — pas seulement non-membre, propriétaire de son **propre** tenant sans aucune relation avec celui de A), un produit, un livreur, un lot reçu (FIFO alimenté), une commande par scénario.

**Note de révision** : le §2.1 (rouge avant) reste la preuve d'origine — sa mesure ne dépend pas de la forme exacte du garde (elle est prise `0148` totalement absente, donc avant toute version du garde), elle reste donc valide telle quelle. Les §§2.2 à 2.5 ont été **intégralement réexécutées** après la correction NULL-safe (§1), sur une commande fraîche par scénario, sur la même stack locale.

### 2.1 Rouge avant (`0148` non appliquée — stack locale à `0147`)

Session réelle de A, `p_actor = B` sur l'appel final `livrer`.

```
rpcError: null
rpcData: "LIVREE"
```

`order_state_transition` (après) contient la ligne `to_status: "LIVREE"`, `actor_user_id: B`. `purchase_lot_line_allocation` créée avec `created_by: B`. `stock_movement` (`movement_type: "sold"`) créé avec `created_by: B`. Les trois transitions précédentes (confirmer/programmer/dispatch, faites avec `p_actor = A`, l'acteur réel) portent correctement A — seule la ligne forgée porte B. **Reproduction confirmée : B n'était même pas membre de la boutique de A, et le journal l'atteste pourtant comme auteur de la livraison et de l'encaissement.**

### 2.2 Vert après (`0148` corrigée, appliquée localement)

Même appel exact (nouvelle commande fraîche, même séquence de setup avec `p_actor = A`, même forge finale `p_actor = B`).

```json
{
  "rpcError": "forbidden",
  "rpcData": null,
  "orderUnchanged": true,
  "transitionCountUnchanged": true,
  "newAllocations": 0,
  "newMovements": 0
}
```

Snapshot `orders`/`order_state_transition` **avant** et **après** l'appel forgé : identiques byte pour byte. Zéro nouvelle ligne `purchase_lot_line_allocation`, zéro nouveau `stock_movement` (`movement_type='sold'`). **Zéro écriture, sur toute la surface vérifiée.**

### 2.3 NOUVEAU — `p_actor` explicitement `NULL`, session valide de A

**C'est le scénario exact du bug corrigé en §1** : session réelle de A (`auth.uid()` non nul), mais `p_actor` envoyé **explicitement à `null`** dans le payload RPC (pas omis — un `null` littéral). Avec l'ancien garde (`p_actor <> v_actor`), `false or NULL` vaut `NULL`, et `if NULL then` ne s'exécute pas : ce scénario serait passé.

```json
{
  "rpcError": "forbidden",
  "rpcData": null,
  "orderUnchanged": true,
  "transitionCountUnchanged": true,
  "newAllocations": 0,
  "newMovements": 0
}
```

**Refusé, zéro écriture — le garde NULL-safe (`is distinct from`) ferme exactement le trou que l'ancien garde laissait ouvert.**

### 2.4 Contrôle positif (`p_actor = auth.uid()` réel)

Même séquence, `p_actor = A` du début à la fin.

```json
{
  "rpcError": null,
  "rpcData": "LIVREE",
  "transitionActorMatchesA": true,
  "allAllocationsMatchA": true,
  "allMovementsMatchA": true
}
```

`order_state_transition.actor_user_id = A` pour la transition `LIVREE`, toutes les lignes `purchase_lot_line_allocation.created_by` et `stock_movement.created_by` = A. La garde ne casse aucun appel légitime — confirmé, pas supposé. Ces trois attributions viennent désormais de `v_actor` (§1, défense en profondeur), pas de `p_actor` repassé tel quel — la preuve reste correcte même si un futur appelant envoyait un `p_actor` légitime mais légèrement désynchronisé, puisque la valeur réellement écrite ne dépend plus de lui.

### 2.5 Sans session (`auth.uid()` nul)

```json
{
  "rpcError": "forbidden",
  "rpcData": null,
  "orderUnchanged": true,
  "transitionCountUnchanged": true
}
```

**Client service-role, sans JWT utilisateur** (bypass RLS, mais pas ce garde-fou) : refusé, zéro écriture. Preuve directe de la décision figée « `auth.uid()` nul est un refus, aucun acteur système implicite ». Le cas clé anon seule (refus au niveau ACL, `permission denied for function transition_order`) reste tel qu'établi en première exécution — non re-testé ici puisque §4.b confirme que l'ACL `anon` n'a pas bougé.

---

## 3. Environnement

Origine unique utilisée pour les quatre preuves et toutes les mesures d'intégrité : **`http://127.0.0.1:54321`** (API/PostgREST), base **`postgresql://...@127.0.0.1:54322/postgres`** — lues directement depuis `pnpm exec supabase status` / `-o env` exécutés dans cette session, jamais depuis un fichier `.env*`. Clé anon décodée : `{"iss":"supabase-demo","role":"anon",...}` — clé de démonstration fixe du CLI Supabase, structurellement incapable d'authentifier un projet hébergé. Aucune écriture distante, sous aucun prétexte.

---

## 4. Vérification d'intégrité — locale uniquement

### 4.a Signature / mode de sécurité / volatilité / `search_path` — diff mécanique réel

**Une affirmation de copie verbatim n'est pas une preuve.** Ce qui suit est un diff `diff(1)` réel entre deux `pg_get_functiondef(...)` interrogés directement sur la même stack locale (reset `supabase db reset --local` entre les deux mesures, `0148` déplacée hors de `supabase/migrations/` pour la mesure « avant », restaurée pour la mesure « après » — jamais une simple lecture du fichier `.sql` sur disque) :

| | Avant (`0147`, oid `19965`) | Après (`0148` corrigée, oid `20021`) |
|---|---|---|
| `prosecdef` (security definer ?) | `false` (invoker) | `false` (invoker) — inchangé |
| `provolatile` | `v` (volatile) | `v` (volatile) — inchangé |
| `proparallel` | `u` (unsafe) | `u` (unsafe) — inchangé |
| `proconfig` | `["search_path=\"\""]` | `["search_path=\"\""]` — inchangé |
| `proacl` | `{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}` | `{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}` — **identique caractère pour caractère** |

(`oid` change entre les deux mesures — c'est attendu, chaque `db reset --local` recrée le catalogue depuis zéro ; ce n'est pas un identifiant stable entre deux resets, seul le contenu de `pg_get_functiondef` compte ici.)

Diff ligne à ligne des deux `pg_get_functiondef` complets (texte exact, capturé dans deux fichiers puis passé à `diff`) :

```diff
43a44,48
>   -- 0148 — attribution non falsifiable (S2). Même variable/même contrôle que le
>   -- garde-fou déjà en place sur post_stock_movement (auth.uid(), 0136) : p_actor
>   -- ne peut plus jamais différer de l'appelant réel de la session, y compris
>   -- pour un appel PostgREST direct forgé hors interface.
>   v_actor                     uuid;
44a50,63
>   -- 0148 — S2 : `p_actor` était jusqu'ici un paramètre reçu de l'appelant,
>   -- jamais confronté à la session réelle — falsifiable par tout appel PostgREST
>   -- direct (JWT valide de A, p_actor = B), preuve locale S2-D. auth.uid() est
>   -- nul hors session authentifiée (aucun appelant système n'existe aujourd'hui,
>   -- cf. rapport S2-D) ; un p_actor qui diffère de l'appelant réel est refusé,
>   -- jamais silencieusement corrigé. Contrôle avant tout accès à la commande :
>   -- il ne dépend d'aucune donnée métier.
>   v_actor := auth.uid();
>
>   if v_actor is null or p_actor is distinct from v_actor then
>     raise exception 'forbidden'
>       using errcode = '42501';
>   end if;
>
243c262
<       p_actor,
---
>       v_actor,
314c333
<           p_actor
---
>           v_actor
362c381
<         p_actor,
---
>         v_actor,
425c444
<         p_actor
---
>         v_actor
498c517
<             p_created_by          := p_actor,
---
>             p_created_by          := v_actor,
514c533
<             p_created_by          := p_actor,
---
>             p_created_by          := v_actor,
534c553
<           p_created_by          := p_actor,
---
>           p_created_by          := v_actor,
560c579
<         p_created_by          := p_actor,
---
>         p_created_by          := v_actor,
621c640
<         p_created_by          := p_actor,
---
>         p_created_by          := v_actor,
654c673
<         p_created_by          := p_actor,
---
>         p_created_by          := v_actor,
670c689
<           p_created_by          := p_actor,
---
>           p_created_by          := v_actor,
701c720
<         p_created_by          := p_actor,
---
>         p_created_by          := v_actor,
```

**Exactement ce qui était prédit — rien d'autre** : la déclaration `v_actor`, le bloc de garde NULL-safe (7 lignes utiles), et 12 substitutions `p_actor` → `v_actor` (4 écritures directes + 8 appels `post_stock_movement`). Aucune autre ligne des ~700 du corps ne diffère. `RETURNS text`, `LANGUAGE plpgsql`, `SET search_path TO ''` identiques ; `SECURITY INVOKER`/`VOLATILE`/`PARALLEL UNSAFE` n'apparaissent pas dans le texte de `pg_get_functiondef` avant comme après — Postgres omet ces clauses quand elles valent leur défaut (invoker/volatile/unsafe sont les défauts), ce qui est cohérent avec `prosecdef`/`provolatile`/`proparallel` mesurés séparément ci-dessus, pas un signe d'omission côté migration.

### 4.b `has_function_privilege` — avant/après, sur la même stack locale

| Rôle | Avant `0148` | Après `0148` |
|---|---|---|
| `anon` | `false` | `false` — inchangé |
| `authenticated` | `true` | `true` — inchangé |
| `service_role` | `true` | `true` — inchangé |

**Aucune divergence locale avant/après.**

### 4.c ACL de production — référence, non re-mesurée dans ce lot

Consignée telle qu'établie par `docs/phaseU/S2-D-ACTOR-ATTRIBUTION.md` §1.b (mesure directe sur la base liée, avant tout travail de ce lot) :

```
proacl = {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
anon EXECUTE = false, authenticated EXECUTE = true, service_role EXECUTE = true
```

**Identique, terme à terme, à l'ACL locale mesurée avant et après `0148`** — le `create or replace` à signature strictement identique ne change rien à l'ACL, en local comme en production attendu. Cette égalité est la référence contre laquelle le fondateur doit comparer sa propre mesure de production après `db push`, pas une preuve de production elle-même — aucune connexion production n'existe dans cet environnement d'exécution.

---

## 5. Tests durables

`tests/rls/s2-transition-order-actor-guard.rls.test.ts` — 3 tests, exécutés contre la stack locale (`pnpm vitest run tests/rls/s2-transition-order-actor-guard.rls.test.ts`), **3/3 verts** :

1. `p_actor` falsifié (utilisateur étranger, hors tenant) → refusé, zéro écriture dérivée.
2. `p_actor = auth.uid()` → succès, attribution correcte sur `order_state_transition`.
3. Client service-role sans session utilisateur → refusé, zéro écriture.

Ces tests prouvent le comportement **courant** (post-`0148`) — l'état rouge d'avant correctif (§2.1) est une preuve historique ponctuelle, non reproductible par une suite durable puisqu'une suite tourne toujours contre le schéma en tête (`0148` déjà appliquée). Documentée ici, pas rejouable.

**Réexécutés après la correction NULL-safe (§1)** : `pnpm vitest run tests/rls/s2-transition-order-actor-guard.rls.test.ts tests/rls/customer-reliability-projection.rls.test.ts --reporter=verbose` → **33/33 verts** (3 + 30). Les 3 tests de ce fichier n'envoient aucun `p_actor` explicitement `NULL` — ils restent donc verts avec l'ancien comme le nouveau garde et ne couvrent pas, à eux seuls, le bug corrigé en §1. **Recommandation, non appliquée dans ce lot** (composition finale des fichiers laissée au porteur) : ajouter un 4ᵉ test à ce fichier reproduisant le scénario §2.3 (`p_actor: null` explicite, session valide) pour que ce bug précis reste couvert par la suite durable, pas seulement par la preuve ponctuelle de ce rapport.

Gotcha rencontré et corrigé pendant l'écriture des tests : `order_state_transition.actor_user_id` et `stock_movement.created_by` référencent `auth.users` **sans** `ON DELETE CASCADE` (contrairement à `merchant_account.owner_user_id`, qui cascade jusqu'à `orders`/`order_line`) — supprimer un utilisateur de test sans nettoyer ces deux tables (+ `audit_log`, ligne `account.created` posée par le trigger de provisioning) fait échouer `auth.admin.deleteUser` avec `Database error deleting user`, laissant des utilisateurs de test orphelins. Corrigé dans le fichier de test (`afterEach` nettoie explicitement ces trois tables avant `deleteUser`). Nettoyage vérifié par requête directe (`select count(*) from auth.users where email like 's2guard-%'` → `0`), pas inféré de la sortie console.

---

## 5bis. Boucle de sanité et conséquences de `0148` sur des tests existants

Boucle complète exécutée sur la branche `phaseS2/transition-order-actor-attribution-guard`, `0148` appliquée localement (état final) :

| Étape | Résultat |
|---|---|
| `pnpm typecheck` | vert |
| `pnpm lint` | vert (676 fichiers) |
| `pnpm test:unit` | vert — 130/130 fichiers, 1049/1049 tests |
| `pnpm test:rls` (suite complète) | voir détail ci-dessous — un échec pré-existant sans rapport avec `0148`, une régression trouvée et corrigée |
| `pnpm security:acl-baseline:check` | vert — confirme zéro dérive d'ACL causée par `0148` |
| Build preview (`VERCEL_ENV=preview pnpm build`) | vert |

**Contrôle à vide (les 3 nouveaux tests ne sont pas verts par saut).** Exécution en mode verbose : les 3 tests de `tests/rls/s2-transition-order-actor-guard.rls.test.ts` apparaissent nommément avec des durées réelles (516 ms / 371 ms / 392 ms). Le seul `.skip` du fichier est `skipIfNoServiceRole`, le garde-fou standard déjà utilisé identiquement dans toute la suite RLS quand `SUPABASE_SERVICE_ROLE_KEY` est absent — il n'était pas actif ici ; les 3 tests se sont réellement exécutés.

**`test:rls` — avant/après `0148` (fichier de migration et suite de tests déplacés hors de l'arbre puis restaurés, stack locale réinitialisée entre les deux mesures) :**

1. **Échec pré-existant, indépendant de `0148`, présent avant ET après** : `tests/rls/shopify-refund-shop-scoped-order-resolution.rls.test.ts` échoue à l'import (erreur Zod, `RESEND_API_KEY` absent — `lib/env.ts:99` via `lib/shopify/apps.ts`). **Ce n'est pas l'anomalie stock-atomicity/`qty_on_hand` de la mémoire du projet** (issue #12) — `tests/rls/stock-atomicity.rls.test.ts` (37 tests) est passé intégralement propre dans les deux runs ; ce flake connu ne s'est pas reproduit cette fois. L'échec observé est purement local : `.github/workflows/ci.yml:130-142` fixe explicitement `RESEND_API_KEY: test-resend-api-key` (valeur synthétique) **pour l'étape `pnpm test:rls` elle-même**, avec un commentaire qui documente déjà ce défaut exact (« Lot R2 (Phase F) : tests/rls/shopify-refund-shop-scoped-order-resolution importe lib/env.ts... requis même si jamais lu par ce test »). Le fichier s'importe donc correctement sur le runner CI ; l'échec local ne reflète qu'une variable d'environnement absente de ce shell, pas une dette de couverture — **ce n'est pas une régression de ce lot, et ce n'est pas non plus un fichier jamais exécuté par la CI**.
2. **Régression réelle, causée par `0148`, trouvée et corrigée dans ce lot** : `tests/rls/customer-reliability-projection.rls.test.ts`, test « changement de statut par le VRAI chemin transition_order », échouait `forbidden` après `0148`. Cause : le test appelait `transition_order` via le client **service-role** (`t.admin`), sans session utilisateur réelle — exactement le chemin sans-session que `0148` referme. Un test qui s'annonce « le VRAI chemin » testait en réalité un chemin qui n'existe nulle part en production (inventaire des appelants, S2-D §3 : le seul appelant réel a toujours une session validée). **Corrigé** : router l'appel via `session` (client déjà signé pour le tenant du test, disponible quelques lignes plus haut) au lieu de `t.admin` — une ligne changée, `p_actor` reste `t.userId`, qui correspond déjà à l'utilisateur de `session`. Réexécuté seul : **30/30 verts**, y compris ce test précis.

**Recherche d'autres appels à `transition_order` par un client admin/service-role dans `tests/`** (demandée avant tout correctif, pour ne pas laisser d'autres échecs latents non expliqués) : grep exhaustif sur `transitionRpc(admin`, `transitionRpc(t.admin`, `.admin.rpc('transition_order'`, `adminClient().rpc('transition_order'` dans tout `tests/`. Deux occurrences trouvées au total :
- `tests/rls/s2-transition-order-actor-guard.rls.test.ts:360` — intentionnelle, c'est le test « sans session » de ce lot lui-même (§2.4), attend précisément le refus.
- `tests/e2e/finances.spec.ts:709` (test `0116 : une commande invalidée disparaît du CA de /finances`) — même défaut que ci-dessus, appel `fixture.admin.rpc('transition_order', { p_invalidate_delivered: true, ... })` sans session. **Causation vérifiée empiriquement, pas seulement par analogie** : le code original (avant correctif), rejoué isolément (`pnpm exec playwright test tests/e2e/finances.spec.ts --project=chromium -g "0116 : une commande invalidée disparaît du CA de /finances"`) contre la même stack locale avec `0148` appliquée, échoue avec exactement l'erreur du nouveau garde :

  ```
  Error: expect(received).toBeNull()
  Received: {"code": "42501", "details": null, "hint": null, "message": "forbidden"}
    at tests/e2e/finances.spec.ts:721:31 — expect(invalidated.error).toBeNull();
  ```

  **Corrigé** par le même principe : ajout d'un helper `signInClient(email)` (clé anon + `signInWithPassword`, calqué mot pour mot sur le helper déjà existant dans `tests/e2e/drivers.spec.ts:59-66`) et remplacement de l'appel par `ownerClient.rpc(...)` où `ownerClient = await signInClient(fixture.email)`. Rejoué isolément avec le correctif, même méthode : **1 passed (18.2s)**. Rouge avant / vert après tous deux mesurés directement, comme pour `customer-reliability-projection.rls.test.ts` — pas seulement affirmés par analogie de motif.

**Portée de la conséquence** : `0148` a révélé que deux tests distincts, dans deux suites différentes, avaient pris le même raccourci (appeler `transition_order` en service-role plutôt qu'en session réelle) — un raccourci qui n'existe pour aucun appelant de production. Les deux corrections rendent ces tests fidèles à ce qu'ils annoncent tester, elles ne les rendent pas verts par complaisance.

---

## 6. Fichiers touchés

**Commit 1 — la migration seule :**
- `supabase/migrations/0148_transition_order_actor_attribution_guard.sql`

**Commit 2 — tests durables, correctifs de conséquence, et rapport de preuve :**
- `tests/rls/s2-transition-order-actor-guard.rls.test.ts` (nouveau)
- `tests/rls/customer-reliability-projection.rls.test.ts` (1 ligne modifiée — conséquence directe de `0148`, voir §5bis)
- `tests/e2e/finances.spec.ts` (helper `signInClient` ajouté + 1 site d'appel modifié — conséquence directe de `0148`, voir §5bis)
- `docs/phaseU/S2-ACTOR-ATTRIBUTION-FIX.md` (ce fichier)

Aucun autre fichier du dépôt modifié. Aucun changement dans la migration `0148` elle-même après son écriture initiale.

---

## 7. Commandes exécutées

Lecture seule / inspection :
```
git status --short
git log --oneline -3
pnpm exec supabase status
pnpm exec supabase status -o env
pnpm exec supabase migration list --local
mcp__postgres__query: select pg_proc.{prosecdef,provolatile,proparallel,proacl,proconfig} ... (avant et après 0148)
mcp__postgres__query: select pg_get_functiondef(oid) ... (avant et après 0148)
mcp__postgres__query: select has_function_privilege('anon'|'authenticated'|'service_role', oid, 'EXECUTE') ... (avant et après 0148)
mcp__postgres__query: requêtes de vérification de suppression (auth.users, merchant_account, orders, order_state_transition, stock_movement, purchase_lot_line_allocation, audit_log, shop)
```

Stack locale uniquement (`http://127.0.0.1:54321` / `54322`) :
```
netstat -ano | grep 5432[1-4]           # confirme le stack déjà démarré, aucun conflit de port
pnpm exec supabase migration up --local # applique UNIQUEMENT 0148, aucun db push
node <script de reproduction éphémère>  # fixtures + appels PostgREST (RED avant migration, GREEN/positif/sans-session après)
pnpm vitest run tests/rls/s2-transition-order-actor-guard.rls.test.ts --reporter=verbose
```

Boucle de sanité et mesure avant/après (§5bis) :
```
grep -rn "transitionRpc(admin\|transitionRpc(t\.admin\|\.admin\.rpc('transition_order'\|adminClient()\.rpc('transition_order'" tests/
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:rls                            # run "avant" — 0148 et le test s2-*.rls.test.ts déplacés hors de l'arbre, stack resetée
pnpm exec supabase db reset --local      # entre les deux mesures, cf. gotcha CLAUDE.md test:rls/test:e2e
pnpm test:rls                            # run "après" — 0148 et le test restaurés, stack resetée puis remigrée
pnpm vitest run tests/rls/customer-reliability-projection.rls.test.ts --reporter=verbose  # re-exécution isolée post-correctif, 30/30
pnpm security:acl-baseline:check
$env:VERCEL_ENV='preview'; pnpm build    # ou VERCEL_ENV=preview pnpm build selon le shell
git status --short                       # confirme l'arbre de travail final
```

Aucun `supabase db push`, aucun `pnpm db:types`, aucune lecture de fichier `.env*`, aucune écriture sur une base distante, aucun `pnpm test:e2e` exécuté.

Réexécution après correction NULL-safe (§1, §2, §4.a) :
```
pnpm exec supabase db reset --local                    # 0148 corrigée appliquée
mcp__postgres__query: select oid from pg_proc where proname='transition_order'
mcp__postgres__query: select pg_get_functiondef(oid)    # capture "après"
mcp__postgres__query: select prosecdef,provolatile,proparallel,proconfig,proacl::text from pg_proc where oid=...
mcp__postgres__query: select has_function_privilege('anon'|'authenticated'|'service_role', oid, 'EXECUTE')
mv supabase/migrations/0148_*.sql <scratch>              # retrait temporaire, jamais supprimé
pnpm exec supabase db reset --local                     # état "avant" (0147)
mcp__postgres__query: select pg_get_functiondef(oid)     # capture "avant"
diff before_0148.sql after_0148.sql                      # diff mécanique réel, §4.a
mv <scratch>/0148_*.sql supabase/migrations/              # restauration
pnpm exec supabase db reset --local                      # état final, 0148 corrigée
node <script de reproduction éphémère, racine du dépôt>  # 4 scénarios : vert/NULL/positif/sans-session (§2.2-2.5)
mcp__postgres__query: select count(*) from auth.users where email like 's2reverify-%'   # 6 orphelins d'essais précédents détectés
node <script de nettoyage éphémère>                       # suppression des 6 orphelins (order_state_transition/stock_movement/purchase_lot_line_allocation/audit_log puis deleteUser)
mcp__postgres__query: select count(*) from auth.users where email like 's2reverify-%'   # confirmé 0
rm <scripts éphémères>
pnpm vitest run tests/rls/s2-transition-order-actor-guard.rls.test.ts tests/rls/customer-reliability-projection.rls.test.ts --reporter=verbose  # 33/33
pnpm typecheck && pnpm lint
pnpm test:rls                                            # suite complète, 376/376 hors l'échec RESEND_API_KEY pré-existant
SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres pnpm security:acl-baseline:check
$env:VERCEL_ENV='preview'; pnpm build
git status --short                                        # arbre final : migration + 2 fichiers de test modifiés + nouveau test + rapport, rien d'autre
```

Note de transparence : le premier passage du script de reproduction a échoué deux fois sur des contraintes `NOT NULL` de `purchase_lot` (`supplier_name`, `ordered_at`) avant de réussir — chaque échec laissait 2 utilisateurs de test orphelins (créés avant l'échec, jamais nettoyés puisque le script s'arrêtait avant d'atteindre le bloc de cleanup). Détecté par la vérification par requête directe (pas par confiance dans la sortie console), et nettoyé par un script dédié avant de continuer — cf. ligne ci-dessus.

## §8 — Dettes consignées, non ouvertes dans ce lot

Deux fonctions identifiées comme candidates au même motif que `transition_order`/`0148` (un identifiant d'acteur reçu du client, jamais confronté à `auth.uid()`), signalées pour mémoire — aucune des deux n'est touchée par 0148, aucune n'est ouverte ici :

- **`reassign_order_driver`** — repérée par deux diagnostics distincts pour deux motifs distincts (à réconcilier avant tout travail dessus, ne pas supposer qu'un seul correctif couvre les deux).
- **`receive_purchase_lot`** — même motif d'acteur falsifiable que celui fermé par 0148 sur `transition_order`.

À rouvrir comme lot dédié, avec son propre S2-D (falsifiabilité/impact/appelants) avant tout correctif — ne pas réutiliser le diagnostic S2-D de `transition_order` par analogie.
