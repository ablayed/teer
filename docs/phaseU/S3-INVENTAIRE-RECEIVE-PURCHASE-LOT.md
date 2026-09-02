# S3 — Inventaire préalable : appelants, ACL, frontière d'identité (`receive_purchase_lot` et les 5 mutations legacy d'un arrivage)

**Lecture seule. Aucun correctif, aucune migration, aucun test écrit dans ce travail. Non commité —
en attente de la mesure ACL production (§3) et de la relecture du fondateur.**

Ce document établit les faits nécessaires à cadrer le lot S3 (fermeture du P0 « garde boutique
absente sur le cycle de vie legacy d'un arrivage », `docs/phaseU/U0-D2-DIAGNOSTIC-LECTURE-SEULE.md`
§8). Il ne propose aucune ligne de SQL de correctif.

**Correction méthodologique appliquée sur relecture** : les deux questions — (a) quel client écrit,
et ses privilèges ; (b) quelles policies RLS s'appliquent à `authenticated` — sont **indépendantes**
et traitées séparément pour chacune des 5 actions. Une policy RLS correcte ne protège **que** la
surface `authenticated` directe ; elle ne compte pour rien sur le chemin admin (le client
service-role contourne RLS par construction, RLS n'est même pas évaluée sur ce chemin).

---

## 1. Par action — client, appelants, surface directe, policies (surface directe uniquement)

### 1.1 `updatePurchaseLotAction` (`lib/actions/purchases.ts:146-169`)

| Question | Réponse |
|---|---|
| **Client effectif pour l'écriture** | `createSupabaseAdminClient()` — service-role, clé `SUPABASE_SERVICE_ROLE_KEY`. **Contourne RLS par construction.** Écrit `.update({supplier_name, reference, ordered_at, estimated_lead_time_days, transport_total}).eq('id', lotId).eq('merchant_account_id', merchantAccountId).neq('status','received')` — aucun `.eq('shop_id', ...)`. |
| **Appelants réels de l'action** | **Aucun** — confirmé par grep exhaustif sur `components/`/`app/` : `updatePurchaseLotAction` est importée nulle part hors de sa propre déclaration. Exportée, jamais invoquée. Rôle effectif : N/A (aucune exécution en production aujourd'hui). |
| **Surface directe (bypass de l'action)** | **Oui, existe.** `purchase_lot` a des grants colonne `UPDATE` à `authenticated` couvrant exactement ces 5 colonnes : `supplier_name`/`reference`/`ordered_at` (`0033:163-179`), `estimated_lead_time_days`/`transport_total` (`0053:89-90`). Un client authentifié pourrait appeler `.from('purchase_lot').update({...}).eq('id', lotId)` directement via PostgREST, sans passer par cette action. |
| **Policy RLS applicable à cette surface directe** | `purchase_lot_update` (`0127_workspace_store_rls_and_views.sql:105-108`) : `using/with check (current_member_role(merchant_account_id) is not null and current_shop_role(shop_id) = 'owner')` — **correctement scopée boutique** (réécrite en 0127, remplace la version 0033 qui n'était scopée qu'au compte). **La surface directe est donc déjà protégée par RLS aujourd'hui.** |
| **Conclusion** | Le seul chemin vulnérable est l'action elle-même (admin, sans garde). La surface directe existe mais est saine. **Garde TS suffisante** — aucune modification RLS nécessaire. Coût de correction nul côté UI (aucun appelant à revalider). |

### 1.2 `addPurchaseLotLineAction` (`lib/actions/purchases.ts:173-215`)

| Question | Réponse |
|---|---|
| **Client effectif** | `createSupabaseAdminClient()` — service-role. Écrit `.insert({merchant_account_id, shop_id: lot.shop_id, purchase_lot_id, product_id, qty, purchase_price_total})`. Confronte le produit à `lot.shop_id` (pas la boutique active) avant l'insert (`resolveProductInShop`, ligne 193-198) — protège l'intégrité produit↔lot, pas l'autorisation appelant↔boutique. |
| **Appelants réels** | Bouton « + Ajouter un produit » (`components/purchases/purchase-lots-view.tsx`), monté pour tout lot non reçu. Seul appelant UI identifié. Rôle effectif à l'exécution : `owner` (imposé par `requireRole('owner')`), session réelle, `auth.uid()` renseigné. |
| **Surface directe** | **Oui, existe.** `purchase_lot_line` a des grants colonne `INSERT` à `authenticated` couvrant `merchant_account_id`/`purchase_lot_id`/`product_id`/`qty` (`0033:278-284`), `shop_id` (`0130:59`), `purchase_price_total` (`0053:121-122`) — l'insert complet de cette action est couvrable par un appel PostgREST direct. |
| **Policy RLS applicable** | `purchase_lot_line_insert` (`0127:116-118`) : `with check (current_member_role(...) is not null and current_shop_role(shop_id) = 'owner')` — scopée boutique. **Surface directe déjà protégée.** |
| **Conclusion** | Même situation que 1.1 : la vulnérabilité est dans l'action (admin, garde produit↔lot mais pas boutique↔appelant), pas dans la surface directe (RLS déjà correcte). **Garde TS suffisante** — ajouter la confrontation `lot.shop_id === shopId actif`, en plus de la garde produit déjà présente (qui reste nécessaire, elle protège un invariant différent). |

### 1.3 `removePurchaseLotLineAction` (`lib/actions/purchases.ts:219-246`)

| Question | Réponse |
|---|---|
| **Client effectif** | `createSupabaseAdminClient()` — service-role. `.delete().eq('id', lineId).eq('purchase_lot_id', lotId).eq('merchant_account_id', merchantAccountId)` — aucun `.eq('shop_id', ...)`. |
| **Appelants réels** | Bouton « × » ligne (`purchase-lots-view.tsx`). `owner`, session réelle, `auth.uid()` renseigné. |
| **Surface directe** | **Non — n'existe pas.** Grep exhaustif sur toutes les migrations : **aucun `grant delete` n'a jamais été émis sur `purchase_lot_line` pour `authenticated`**, et **aucune policy `for delete` n'a jamais été créée** sur cette table (seules `select`/`insert`/`update` existent, `0033` et `0127`). `FORCE ROW LEVEL SECURITY` est actif — sans policy `delete`, la suppression est refusée par défaut, et sans `grant delete`, PostgREST refuserait avant même d'évaluer RLS. |
| **Policy RLS applicable** | Sans objet — aucune surface directe à protéger. |
| **Conclusion** | Chemin unique = l'action (admin). **Garde TS suffisante**, et c'est la SEULE garde possible ici — il n'existe même pas de mécanisme RLS à réparer en parallèle. |

### 1.4 `markLotInTransitAction` (`lib/actions/purchases.ts:250-267`)

| Question | Réponse |
|---|---|
| **Client effectif** | `createSupabaseAdminClient()` — service-role. `.update({status:'in_transit'}).eq('id', lotId).eq('merchant_account_id', merchantAccountId).eq('status','ordered')` — aucun `.eq('shop_id', ...)`. |
| **Appelants réels** | Bouton « Marquer en transit » (`purchase-lots-view.tsx`). `owner`, session réelle. |
| **Surface directe** | **Oui, existe.** `status` fait partie des colonnes `UPDATE` grantées à `authenticated` dès `0033:163-179`. |
| **Policy RLS applicable** | `purchase_lot_update` (même policy que 1.1, `0127:105-108`) — scopée boutique, **déjà protégée**. |
| **Conclusion** | Même situation que 1.1/1.2. **Garde TS suffisante.** |

### 1.5 `receiveLotAction` (`lib/actions/purchases.ts:271-328`) — cas distinct, pas symétrique aux quatre précédents

| Question | Réponse |
|---|---|
| **Client effectif** | **Deux clients dans la même action.** (a) `createSupabaseAdminClient()` pour les LECTURES du lot et des lignes (lignes 279-297, avant tout changement d'état — bypass RLS, mais lecture seule à ce stade). (b) `ctx.supabase` (client cookie-based, authentifié, session réelle) pour l'appel RPC `receive_purchase_lot` lui-même (ligne 316-317) — **c'est l'écriture réelle** (changement de statut + mouvements de stock, dans la transaction Postgres de la RPC). |
| **Appelants réels de l'ACTION TS** | Bouton « Marquer reçu » (`purchase-lots-view.tsx`). `owner`, session réelle, `auth.uid()` renseigné. |
| **Appelants réels de la RPC `receive_purchase_lot` elle-même** (distincte de l'action) | Voir §2 — un seul appelant applicatif (cette action), plus 9 fichiers de test, tous via un client authentifié (`signIn`/`signInSupabaseJs`, session réelle). Aucun appelant service-role identifié pour cette RPC précise. |
| **Surface directe** | **Oui, existe — et c'est différent des 4 actions précédentes.** `EXECUTE` grantée à `authenticated`, `anon` fermé — **mesuré, §3.c**. N'importe quel `authenticated` peut donc l'appeler directement via PostgREST, sans passer par l'action TS. |
| **RLS s'applique-t-elle à l'intérieur de la fonction ?** | **Non — mesuré, §3.c (Scénario A confirmé).** `receive_purchase_lot` est `SECURITY DEFINER`, propriétaire `postgres`, `rolbypassrls = true`. Malgré `FORCE ROW LEVEL SECURITY` actif sur les deux tables, les policies (pourtant correctement scopées boutique depuis `0127`) sont **inopérantes** pour tout ce que fait cette fonction en son sein — le contournement vient de l'attribut du propriétaire, pas d'une absence de `FORCE RLS`. |
| **Garde interne à la RPC (à la place de RLS)** | `current_member_role(p_merchant_account_id) is distinct from 'owner'` (`0043`/`0138`, dernière définition vivante) — **scope COMPTE, jamais boutique.** Contrairement aux policies RLS `purchase_lot_update`/`purchase_lot_line_*` qui ont été mises à niveau vers `current_shop_role` en `0127`, cette garde interne n'a **jamais** été mise à niveau. |
| **Conclusion — confirmée par mesure, §3.c** | La garde interne compte-seule est le **seul** rempart aujourd'hui sur cette surface, et elle ne couvre pas la boutique. `receive_purchase_lot` est appelable directement par tout `authenticated owner` du compte, sur un lot de N'IMPORTE QUELLE boutique de ce compte. **La surface est ouverte aujourd'hui**, pas une hypothèse. Une garde ajoutée dans la RPC elle-même (`current_shop_role(v_lot.shop_id) is distinct from 'owner'`, NULL-safe) est nécessaire pour la fermer — une garde TS seule dans `receiveLotAction` ne la fermerait pas, cette surface étant atteignable indépendamment de l'action. |

---

## 2. Appelants de `receive_purchase_lot` — exhaustif (inchangé depuis la première version de cet inventaire, revérifié)

| Appelant | Fichier | Client au moment de l'appel RPC | `auth.uid()` renseigné ? |
|---|---|---|---|
| `receiveLotAction` (production, seul appelant applicatif) | `lib/actions/purchases.ts:316-317` | `ctx.supabase` — authentifié | Oui, toujours |
| `tests/rls/purchases.rls.test.ts:329,513` | RLS | `signIn(email)` — anon key + `signInWithPassword` | Oui |
| `tests/rls/lot-f1-finances-v2-socle.rls.test.ts:298` | RLS | idem | Oui |
| `tests/rls/lot-f2-purchase-lot-profitability.rls.test.ts:322` | RLS | idem | Oui |
| `tests/rls/lot-f2bis-ad-spend-separation.rls.test.ts:205` | RLS | idem | Oui |
| `tests/e2e/lot-f2-purchase-lot-detail.spec.ts:249` | E2E | `signInSupabaseJs(email)` | Oui |
| `tests/e2e/lot-u1f-tabular-nums.spec.ts:202` | E2E | idem | Oui |
| Cron, webhooks, scripts | — | Grep confirmé : **aucun appel** dans les trois cas | N/A |

**Aucun appelant service-role/sans session identifié pour cette RPC précise.** Une garde
`current_shop_role`/`auth.uid()`-based ne casserait aucun appelant recensé — **mais** cela ne
dispense pas de la garde (§1.5) : elle ferme une surface directe distincte de l'usage applicatif
normal, atteignable indépendamment de tous les appelants listés ici.

---

## 3. ACL — requêtes formatées pour exécution en production

**Aucune mesure live effectuée** (aucun stack local démarré dans cette session — connexion refusée
sur `127.0.0.1:54322` ; aucune tentative de connexion production, jamais disponible depuis cet
environnement). Ce qui suit est `probable` par lecture de l'historique de migration (tableau §3.b),
jamais `prouvé` par mesure — d'où la nécessité des requêtes ci-dessous.

### 3.a Requêtes à exécuter, dans l'ordre

**Correction de méthode appliquée** : `SECURITY DEFINER` n'implique pas, à lui seul, que RLS est
inopérante — cela dépend de `pg_roles.rolbypassrls` sur le PROPRIÉTAIRE de la fonction ; si le
propriétaire n'a pas `BYPASSRLS` et que les tables sont en `FORCE ROW LEVEL SECURITY`, les policies
s'appliquent quand même à l'exécution de la fonction. Établi ci-dessous (bloc 1), pas déduit. Tous
les grants viennent des catalogues réels (`pg_proc.proacl`, `pg_class.relacl`,
`information_schema.column_privileges`, `has_function_privilege`, `has_table_privilege`) — jamais du
texte des migrations, qui peut avoir divergé de l'état effectif.

```sql
-- ── Bloc 1 : ACL de la RPC receive_purchase_lot + propriétaire + BYPASSRLS ──
select
  p.oid::regprocedure         as signature,
  p.prosecdef                 as security_definer,
  p.proacl                    as raw_acl,
  pg_get_userbyid(p.proowner) as owner_role,
  r.rolsuper                  as owner_is_superuser,
  r.rolbypassrls              as owner_bypassrls
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_roles r on r.oid = p.proowner
where n.nspname = 'public' and p.proname = 'receive_purchase_lot';

select
  has_function_privilege('anon', 'public.receive_purchase_lot(uuid,uuid,uuid,jsonb)', 'EXECUTE')         as anon_exec,
  has_function_privilege('authenticated', 'public.receive_purchase_lot(uuid,uuid,uuid,jsonb)', 'EXECUTE') as authenticated_exec,
  has_function_privilege('service_role', 'public.receive_purchase_lot(uuid,uuid,uuid,jsonb)', 'EXECUTE')  as service_role_exec;
```

```sql
-- ── Bloc 2 : grants réels sur purchase_lot / purchase_lot_line (catalogues, pas le texte des migrations) ──
select relname, relacl
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('purchase_lot', 'purchase_lot_line');

select table_name, column_name, privilege_type
from information_schema.column_privileges
where table_schema = 'public'
  and table_name in ('purchase_lot', 'purchase_lot_line')
  and grantee = 'authenticated'
order by table_name, privilege_type, column_name;

-- Note de lecture : has_table_privilege renvoie TRUE dès qu'AU MOINS UNE colonne
-- porte le privilège pour SELECT/INSERT/UPDATE/REFERENCES (comportement Postgres
-- documenté) — ne pas lire "true" comme "table entière accessible". Le détail
-- colonne par colonne ci-dessus fait foi, ceci n'est qu'un résumé binaire.
select
  has_table_privilege('authenticated', 'public.purchase_lot', 'SELECT')      as pl_select,
  has_table_privilege('authenticated', 'public.purchase_lot', 'INSERT')      as pl_insert,
  has_table_privilege('authenticated', 'public.purchase_lot', 'UPDATE')      as pl_update,
  has_table_privilege('authenticated', 'public.purchase_lot', 'DELETE')      as pl_delete,
  has_table_privilege('authenticated', 'public.purchase_lot_line', 'SELECT') as pll_select,
  has_table_privilege('authenticated', 'public.purchase_lot_line', 'INSERT') as pll_insert,
  has_table_privilege('authenticated', 'public.purchase_lot_line', 'UPDATE') as pll_update,
  has_table_privilege('authenticated', 'public.purchase_lot_line', 'DELETE') as pll_delete;
```

```sql
-- ── Bloc 3 : policies RLS actives sur purchase_lot / purchase_lot_line ──
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('purchase_lot', 'purchase_lot_line')
order by tablename, cmd;
```

```sql
-- ── Bloc 4 : FORCE ROW LEVEL SECURITY / relrowsecurity ──
select relname, relrowsecurity, relforcerowsecurity
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('purchase_lot', 'purchase_lot_line');
```

### 3.b Ce qui est établi par lecture de migration (à confirmer par 3.a — texte de migration, jamais un substitut à la mesure catalogue)

| Fait attendu | Source | Statut |
|---|---|---|
| `receive_purchase_lot` : `EXECUTE` à `authenticated`, révoqué de `public`/`anon` | `0034` (grant), `0140:150-155` (revoke public/anon nommé, jamais `authenticated`) | `probable` |
| `purchase_lot_update`/`purchase_lot_line_insert`/etc. : scopées `current_shop_role(shop_id) = 'owner'` | `0127:99-122` (réécrit depuis la version compte-seule de `0033`) | `probable` |
| Aucune policy/`grant delete` sur `purchase_lot_line` | Grep exhaustif migrations, aucune occurrence | `probable` |
| `FORCE ROW LEVEL SECURITY` actif sur les deux tables | `0033:99-100,239-240`, jamais désactivé depuis (grep `disable row level security.*purchase_lot` → 0 résultat) | `probable` |

### 3.c Résultats mesurés en production — attestation du porteur

**Avertissement de méthode, à ne pas effacer** : ce qui suit est l'**attestation du porteur**
(résumé transmis après exécution des quatre blocs en production), **pas les lignes brutes des
catalogues**. Aucune ligne de résultat brute (JSON/tableau `psql`) n'a été fournie à cet agent — la
distinction entre « le porteur atteste avoir mesuré X » et « voici les lignes exactes renvoyées par
`pg_proc`/`pg_policies` » est délibérément préservée ici plutôt que gommée, conformément à la règle
du projet sur l'attestation du porteur comme preuve valide (CLAUDE.md, règle #4) — mais une
attestation reste une attestation, pas une capture de catalogue. Si les lignes brutes existent par
ailleurs, les ajouter ici les rendrait vérifiables indépendamment ; en leur absence, ce qui suit est
`prouvé` au sens où le projet accepte l'attestation du porteur comme preuve de production, et rien de
plus fort que cela.

**Attestation, reproduite verbatim** :

> Scénario A confirmé par mesure. `receive_purchase_lot` est `SECURITY DEFINER`, propriétaire
> `postgres` avec `rolbypassrls = true`, `EXECUTE` ouvert à `authenticated`, `anon` fermé. Les
> policies sont donc inopérantes pour un appel direct de cette fonction, malgré `FORCE ROW LEVEL
> SECURITY` actif sur les deux tables. La garde interne en portée compte est le seul rempart, et la
> surface est ouverte aujourd'hui.
>
> Surfaces directes des quatre autres actions : saines. Six policies, toutes en
> `current_shop_role(shop_id) = 'owner'`, en `USING` et en `WITH CHECK` pour les `UPDATE`. Aucun
> `DELETE` accordé à `authenticated` nulle part — ni en grant colonne, ni dans `relacl`. La
> suppression de ligne n'a effectivement aucune surface directe.

**Conséquence directe sur le verdict §1.5** : le **Scénario A** (propriétaire `rolbypassrls`) est
confirmé, le **Scénario B** est écarté. RLS est réellement inopérante à l'intérieur de
`receive_purchase_lot` malgré `FORCE ROW LEVEL SECURITY` sur les deux tables — le contournement
vient du propriétaire (`postgres`, `rolbypassrls = true`), pas d'une absence de `FORCE RLS`. La garde
interne compte-seule (`current_member_role(...) is distinct from 'owner'`) est donc bien le **seul**
rempart aujourd'hui sur cette surface, et elle ne couvre pas la boutique — **la surface est ouverte,
pas seulement probable.**

**Conséquence directe sur §1.1-1.4** : les surfaces directes des 4 autres actions sont confirmées
saines (six policies confirmées `current_shop_role(shop_id) = 'owner'`, `USING`+`WITH CHECK` pour les
`UPDATE`), et l'absence totale de surface `DELETE` sur `purchase_lot_line` est confirmée (aucun
`grant delete`, absent de `relacl`). Les conclusions `probable` de §1.1-1.4 passent à `prouvé` par
cette mesure.

---

## 4. `disconnectShopAction` (legacy) — atteignabilité avant correctif

**Vérifié avant toute recommandation, comme demandé.** Grep exhaustif de `disconnectShopAction`
(import et usage) sur tout `app/`/`components/` :

- `lib/actions/shopify.ts:51` exporte la version legacy (sans `requireRole`).
- **Seul importeur** : `components/shops/disconnect-shop-button.tsx:4`.
- **Seul monteur de `DisconnectShopButton`** : `app/(app)/boutiques/page.tsx:1,142`.
- `components/settings/settings-shops.tsx:6,37` importe un `disconnectShopAction` **différent**,
  depuis `lib/actions/shops.ts` (le namespace moderne, `requireRole('owner')`, scopé `shopId`) — pas
  le même symbole, pas le même fichier, malgré le nom identique.

**Conclusion : la version legacy n'est atteignable que par `/boutiques`, nulle part ailleurs.**
Conformément à l'instruction reçue : le correctif approprié est la **suppression** de la route
`/boutiques` (ou a minima du bouton et de l'export `disconnectShopAction`/`syncOrdersAction` legacy
qu'elle est seule à utiliser) et une redirection vers `/parametres` → onglet « Shops », pas l'ajout
d'une garde de rôle sur un chemin à retirer. `getShopConnection()` (même fichier) reste utilisée
ailleurs (`app/(app)/commandes/page.tsx:139`, pour l'état du bouton de sync) — donc **le fichier
`lib/actions/shopify.ts` n'est pas mort dans son ensemble**, seuls `disconnectShopAction` et la
route `/boutiques` qui l'expose le sont candidats à suppression. `syncOrdersAction` du même fichier
mériterait la même vérification d'atteignabilité avant de décider suppression vs garde — non faite
ici (hors du périmètre de cette relecture, qui portait sur `disconnectShopAction`).

---

## 5. Coût de fermeture, révisé (post-mesure)

| Action | Chemin vulnérable réel | Où la garde doit vivre | Coût | Risque de régression |
|---|---|---|---|---|
| `updatePurchaseLotAction` | Action seule (admin) ; surface directe **confirmée saine** par mesure (§3.c) | TS — **portée du retrait/garde encore à trancher, voir §6.2** | Nul (aucun appelant UI *trouvé par grep*, §6.2 exige une recherche complète avant d'agir) | Aucun connu |
| `addPurchaseLotLineAction` | Action seule (admin) ; surface directe **confirmée saine** par mesure | TS uniquement | Faible (1 appelant UI) | Faible |
| `removePurchaseLotLineAction` | Action seule (admin) ; **aucune surface directe, confirmé** (aucun `grant delete`, absent de `relacl`) | TS uniquement | Faible (1 appelant UI) | Faible |
| `markLotInTransitAction` | Action seule (admin) ; surface directe **confirmée saine** par mesure | TS uniquement | Faible (1 appelant UI) | Faible |
| `receiveLotAction` | **Action ET surface directe, les deux confirmées vulnérables** (§3.c, Scénario A) | **TS (chemin applicatif) ET migration RPC (garde compte→boutique dans `receive_purchase_lot`)** — la garde RPC est nécessaire, pas seulement défensive, la mesure l'a confirmé | Faible côté TS ; côté RPC, nul pour les appelants recensés (§2, tous authentifiés) — mais nécessite un test dédié à la boutique (l'existant, `purchases.rls.test.ts`, couvre un mismatch de tenant, pas de boutique) | Nul pour les appelants actuels si la garde RPC est `is distinct from` (NULL-safe), jamais `<>` |
| `disconnectShopAction` (legacy) | Route `/boutiques` entière — **portée exacte encore à trancher, voir §6.3** | Suppression, pas une garde — conditionnée à la vérification de `syncOrdersAction` (§6.3) | Faible (1 route, 1 redirection) une fois §6.3 tranché | Aucun si `/parametres` → Shops couvre déjà le besoin |

---

## 6. Trois ajustements retenus avant tout correctif — aucun n'est exécuté ici

### 6.1 Grants `UPDATE` sur des valeurs dérivées — signalé, pas classé

`authenticated` porte un grant `UPDATE` sur `purchase_lot.received_at` et sur
`purchase_lot_line.allocated_fees`, `landed_unit_cost`, `landed_total_value`, `line_value` (confirmé
§3.c, grants colonne réels). Ce sont des valeurs **dérivées**, normalement écrites uniquement par
`receive_purchase_lot` (à la réception) et par `correct_purchase_lot_cost` (correction post-réception,
`0147`) — jamais directement par un formulaire.

**Ce que le grant prouve, et ce qu'il ne prouve pas** : il prouve qu'une écriture directe est
*possible* au niveau grant+RLS (la policy `purchase_lot_line_update`/`purchase_lot_update`,
`current_shop_role(shop_id) = 'owner'`, laisserait passer un `owner` sur sa propre boutique). Il ne
prouve PAS que cette écriture *aboutit* avec une valeur arbitraire — un trigger ou une contrainte
`CHECK` peut la neutraliser après coup (les contraintes `_nonnegative` existent déjà sur ces colonnes,
`0033`, mais n'empêchent pas une valeur positive incohérente).

**Traité comme un risque d'intégrité à reproduire, pas comme une dette acquise — non classé P0/P1
ici.** Avant d'ouvrir un lot ou de classer sa sévérité : reproduire par un appel PostgREST direct sur
stack locale — un `owner` authentifié écrivant un `landed_unit_cost` arbitraire sur une ligne de son
propre lot déjà reçu, et constater si la valeur est acceptée telle quelle, silencieusement corrigée,
ou rejetée. Cette reproduction n'a pas été faite dans ce travail (lecture seule, aucun appel réseau
vers la production ni vers un stack local — aucun stack n'était démarré, cf. restrictions).

### 6.2 `updatePurchaseLotAction` sort du périmètre de garde immédiat de S3

Son absence d'appelant UI n'a été établie que par un grep d'import (`U0-D2-DIAGNOSTIC-LECTURE-SEULE.md`
§5, cet inventaire §1.1) — **pas une recherche complète** (références dynamiques, tests, scripts,
appels indirects via un futur composant non encore lu). La décision de la **supprimer** (plutôt que
de la garder) est un petit lot de code mort séparé, à mener après cette recherche complète.

**Jusqu'à ce que ce lot de suppression tranche, `updatePurchaseLotAction` reste l'une des actions à
garder en TypeScript dans S3** — la question ouverte n'est pas « faut-il la protéger », c'est
« faut-il la protéger ou la supprimer », et tant que ce n'est pas tranché, la protéger est le choix
par défaut le plus sûr (une action non supprimée et non gardée resterait un chemin ouvert).

### 6.3 `/boutiques` reste un lot distinct de S3, avec une vérification à compléter avant

Portée du lot séparé : suppression de la route `/boutiques`, du bouton `DisconnectShopButton`, et de
l'export `disconnectShopAction` legacy (`lib/actions/shopify.ts`) — après vérification finale
qu'aucun autre appelant ne subsiste. **`syncOrdersAction` du même fichier n'a pas eu son
atteignabilité vérifiée** (contrairement à `disconnectShopAction`, dont l'unique importeur a été
confirmé, §4) — à faire avant de décider suppression vs garde pour cette seconde action, dans le même
lot ou dans un lot jumeau, pas en supposant qu'elle suit le même sort par analogie.

---

## 7. Forme retenue pour S3 (décrite, non implémentée)

S3 se tient en **deux preuves distinctes**, à livrer séparément :

1. **Un commit de gardes TypeScript** — quatre ou cinq actions (`addPurchaseLotLineAction`,
   `removePurchaseLotLineAction`, `markLotInTransitAction`, `receiveLotAction`, et
   `updatePurchaseLotAction` sauf si le lot §6.2 a déjà tranché sa suppression avant que ce commit ne
   soit préparé), chacune confrontant la boutique active de l'appelant au `shop_id` du lot chargé,
   avant toute écriture.
2. **Une migration sur `receive_purchase_lot`** — montant la garde de `current_member_role` (compte)
   vers `current_shop_role` (boutique), en `create or replace` à signature strictement identique, ACL
   vérifiée avant et après (les mêmes catalogues qu'au §3.a, pas le texte de la migration), preuve par
   un appel PostgREST direct rouge (avant) puis vert (après) sur stack locale — méthode identique à
   `0148` (`docs/phaseU/S2-ACTOR-ATTRIBUTION-FIX.md`), adaptée à une garde de boutique plutôt qu'à une
   garde d'attribution d'acteur.

Ni l'un ni l'autre n'est rédigé dans ce travail.

---

## Restrictions respectées

Aucun correctif, migration, garde ou test écrit ou modifié. Aucune tentative de connexion à une base
de production. Aucune commande Docker/`supabase start` exécutée. Aucun fichier d'environnement lu.
Requêtes §3.a exécutées en production par le fondateur ; résultats reçus sous forme d'attestation
(§3.c), pas de lignes brutes de catalogue — distinction préservée explicitement dans le texte.
