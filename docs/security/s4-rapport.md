# S4 — Rapport final

## 1. Mesures Étape 0

Voir `docs/security/s4-etape0-mesures.md` (commité séparément). Résumé :

- **Schémas exposés** : `["public", "graphql_public"]` — identiques dans `supabase/config.toml`,
  `scripts/lib/acl-snapshot.mjs`, et le test Couche 1 existant. Aucun écart.
- **Client admin (clé service-role)** : `service_role` porte `rolbypassrls = true` au niveau du
  rôle Postgres lui-même — le contournement RLS est **inconditionnel**, pas dépendant d'un JWT
  transmis ou non. 0/26 fichiers alors recensés (27 aujourd'hui, un est apparu depuis dans la
  mesure — voir §5) ne transmettent de JWT utilisateur au client admin. L'affirmation "ce client
  contourne RLS sans condition" est donc exacte pour ce dépôt, mesurée et non supposée.

## 2. Liste des 32 routines admises en `legacy-uncovered` (ratchet)

Arbitrage du porteur (2026-09-04) : ratchet pour ces 32, fermeture complète pour les 4 sans aucune
couverture connue (§3). Avec les 3 routines déjà `covered` par des lots antérieurs
(`correct_purchase_lot_cost`, `receive_purchase_lot`, `current_shop_role`) et les 4 fermées dans ce
lot (§3), la liste blanche compte 39 entrées au total (32 `legacy-uncovered` + 7 `covered`) —
`supabase/security/definer-authenticated-whitelist.json` fait foi. Chaque entrée `legacy-uncovered`
porte `loggedAt: "2026-09-04"` et une `debt` nommée :

`accept_invitation`, `accept_pending_invitation_by_email`, `consume_pcd_access_quota`,
`consume_shopify_dsar_download_authorization`, `current_member_role`, `finance_kpis`,
`get_dashboard_cash_collected_total`, `get_dashboard_deliveries_by_product`,
`get_dashboard_shop_performance`, `get_driver_cash_consolidation`,
`get_driver_cash_outstanding_orders`, `get_my_store`, `get_report_driver_cash_pending`,
`get_report_revenue_by_day`, `get_report_status_breakdown`, `get_report_top_products`,
`ia_count_recent_tool_calls`, `ia_finance_cost_movements`, `ia_product_cump`,
`is_driver_in_shop`, `is_member_of`, `issue_shopify_dsar_download_authorization`,
`list_my_pending_invitations`, `log_ia_tool_audit`, `log_pcd_access_event`,
`post_stock_movement`, `record_cash_settlement`, `reduce_order_cart_post_assignment`,
`replace_order_cart`, `reserve_manual_order_number`, `set_order_note`, `write_off_shortfall`,
plus `correct_purchase_lot_cost`, `receive_purchase_lot`, `current_shop_role` marquées `covered`
(couverture déjà confirmée par les lots 0147/0148/0150 — pas de nouvelle preuve nécessaire).

**Ce que le ratchet garantit dès ce lot** : toute NOUVELLE routine SECURITY DEFINER×authenticated
qui apparaîtrait sans être inscrite dans `definer-authenticated-whitelist.json` fait échouer
`tests/rls/security-definer-authenticated-whitelist.rls.test.ts` en CI. L'arriéré des 32 n'est PAS
fermé — chaque entrée reste une dette non vérifiée, datée pour rester honnête (jamais un trou
silencieux permanent).

## 3. Les 4 routines sans couverture connue — investiguées, dans le périmètre

Chaque définition a été lue en direct (`pg_get_functiondef`) avant d'écrire un test — jamais
devinée depuis une migration.

- **`is_shop_member_of(p_shop_id)`** — c'est la primitive d'appartenance elle-même. Confronte
  `p_shop_id` (client) à une ligne réelle `shop_member` scopée par `auth.uid()` (jamais un id
  transmis), croise `merchant_account_id` entre `shop_member` et `shop`. **Aucun défaut trouvé** —
  la primitive fait déjà le croisement id-client/parent-autoritaire qu'elle est censée faire.
  3 tests (propre boutique, autre boutique du même compte, boutique d'un autre compte).
- **`list_my_stores()`** — aucun paramètre, portée entièrement par `auth.uid()`. Structurellement
  immunisée contre la classe de défaut visée par ce lot. 2 tests de non-fuite.
- **`cash_aging(p_merchant)`** — gardée par `current_member_role(p_merchant) IN
  ('owner','manager')`, appliquée en CTE et en filtre final. Appelant non autorisé → jeu de
  résultats **vide**, jamais une erreur (vérifié NULL-safe : `current_member_role` retourne NULL
  pour un non-membre, `NULL IN (...)` n'est jamais vrai). Aucun paramètre boutique dans cette
  fonction (`driver` n'a pas de `shop_id`, N-N via `driver_shop`) — l'axe "autre boutique" n'a
  structurellement pas de sens ici ; remplacé par l'axe "même compte, rôle `agent` insuffisant".
  3 tests.
- **`purge_pcd_access_audit(p_before, p_batch_size)`** — **EXECUTE accordé à `authenticated`**
  (constaté via `has_function_privilege`, mesure directe — jamais déduite du texte des migrations)
  alors que la garde interne (`supabase/migrations/0123_s1c_pcd_access_audit.sql:457`, `if
  auth.role() <> 'service_role' then raise exception ...`) rejette inconditionnellement tout
  appelant non `service_role`, quel que soit le tenant. Le texte de `0123`/`0140` ne montre qu'un
  `grant execute ... to service_role` (0123:487) et un `revoke ... from public, anon` (0140:203-206)
  — jamais `authenticated` explicitement — mais un `CREATE OR REPLACE` à signature identique
  préserve l'ACL existante (gotcha déjà documenté dans CLAUDE.md) : le grant `authenticated` mesuré
  aujourd'hui provient d'une version antérieure à `0123` (cf. le commentaire de `0140:27-29` sur
  cette fonction et `log_ia_tool_audit`), jamais retiré depuis. **Aucun défaut exploitable** — le
  rejet est prouvé (test : owner authentifié légitime rejeté, zéro suppression ; service_role
  réussit en contrôle positif). **Écart de posture noté, pas corrigé** : le grant `authenticated`
  est plus large que nécessaire vis-à-vis de la doctrine du projet pour ce type de fonction
  (comparer à `AUTHENTICATED_FORBIDDEN` dans la Couche 1 existante, qui restreint le grant lui-même
  plutôt que de compter sur une vérification runtime seule). Resserrer ce grant exigerait une
  migration — hors périmètre de ce lot (aucune migration). 2 tests.

Aucune des quatre n'a révélé de défaut réel — dans les quatre cas, il ne s'agissait que d'une
preuve manquante. Rien à remonter comme "arrête et remonte" pour ces quatre.

## 4. Recouvrement Splinter / assertion de catalogue

- **0011** (`function_search_path_mutable`) : balaie tous les schémas hors extensions internes —
  **pas de recouvrement direct** avec la Couche 1/liste blanche S4 (portée différente : présence
  de `search_path` dans `proconfig`, pas exécutabilité). A trouvé 4 fonctions réelles (§6).
- **0028** (`anon_security_definer_function_executable`) : recouvre `tests/rls/function-execute-
  acl-invariant.rls.test.ts` (Couche 1 existante, `ANON_EXECUTE_WHITELIST`). Même invariant, deux
  sources indépendantes (requête SQL différente, vendorisée vs écrite pour ce projet).
- **0029** (`authenticated_security_definer_function_executable`) : recouvre entièrement la
  nouvelle liste blanche de la Tâche 3 (`definer-authenticated-whitelist.json`,
  `security-definer-authenticated-whitelist.rls.test.ts`). Une fois les fonctions `RETURNS
  trigger` exclues (18 lignes, non invocables directement — voir §5), les 39 lignes restantes
  correspondent EXACTEMENT aux 39 routines déjà inscrites.

**Ce qu'on perdrait en retirant Splinter** : une source de mesure indépendante, avec son propre
SQL, qui confirmerait un jour une divergence si `collectFunctions()` (notre propre requête,
réutilisée par les deux mécanismes 0028/0029 internes ET par l'assertion de catalogue) avait un
bug silencieux. **Ce qu'on perdrait en retirant l'assertion de catalogue** : le seul mécanisme qui
porte l'identité complète (schéma+nom+signature+rôle+nature+test) et impose une preuve nommée —
Splinter ne fait qu'avertir (`level: WARN`), il ne connaît ni les rôles applicatifs de ce projet ni
les tests qui les couvrent.

## 5. Fonctions `RETURNS trigger` exclues des résultats 0028/0029

Splinter amont ne filtre pas les fonctions à retour `trigger` — or `tests/rls/function-execute-
acl-invariant.rls.test.ts` (Couche 1, déjà en production) a établi **par mesure directe** (`set
role anon; select public.set_updated_at();` → `ERROR: trigger functions can only be called as
triggers`, reproduit en direct) qu'une fonction `RETURNS trigger` est structurellement non
invocable via PostgREST/RPC direct quelle que soit son ACL. `scripts/s4-run-splinter.mjs`
réapplique cette même exclusion déjà prouvée aux RÉSULTATS de 0028/0029 — jamais au SQL vendorisé,
qui reste intact. Mesuré sur ce dépôt (2026-09-04) : **18 lignes exclues sur 0028, 18 sur 0029**,
toutes des fonctions d'intégrité `assert_*_integrity()` (contraintes de type trigger).

## 6. Les 4 vraies trouvailles de Splinter 0011 — admises, pas corrigées

`get_dashboard_kpi`, `customer_reliability_decay_epoch`, `customer_reliability_decay_anchor`,
`customer_reliability_decay_factor` — search_path mutable réel, confirmé (pas un faux positif
trigger). **Hors périmètre de la classe de défaut visée par ce lot** (identifiant client jamais
confronté au parent — ceci est une dette de hardening search_path, catégorie différente).
**Non corrigées ici**, conformément à la consigne explicite du lot ("ne pas fixer, remonter").
Admises dans `supabase/security/search-path-mutable-admitted.json` avec date et dette nommée par
entrée — même mécanisme de ratchet que §2, décidé par cohérence avec l'arbitrage déjà rendu par le
porteur pour la liste blanche (admettre l'historique daté, bloquer toute nouveauté). `get_dashboard
_kpi` mérite un examen séparé : possiblement une fonction historique supplantée par les RPC
period-aware `get_dashboard_*` (PR C1/#84) — encore appelée quelque part, ou candidate au
nettoyage ? Non tranché ici.

## 7. Preuves rouge/vert — les quatre mécanismes

Toutes exécutées sur stack locale, chacune restaurée avant la suivante. `git status --short` après
les cinq preuves : vide (seuls `docs/ci/`, pré-existant et sans rapport, et le fichier de plan de
cette session restent non suivis).

| # | Mécanisme | Action | Avant (rouge) | Après restauration (vert) |
|---|---|---|---|---|
| 1 | Assertion de catalogue — liste blanche | Retrait d'une entrée (`write_off_shortfall`) de `definer-authenticated-whitelist.json` | `tests/rls/security-definer-authenticated-whitelist.rls.test.ts` : 1 failed / 3 passed — `Array ["public.write_off_shortfall(...)"]` non vide | 4 passed |
| 2 | Assertion de catalogue — proconfig | `alter function public.is_shop_member_of(uuid) reset search_path;` (mesuré `proconfig` vidé) | 1 failed / 3 passed — `"...is_shop_member_of... : proconfig sans search_path explicite"` | `alter function ... set search_path to '';` (valeur d'origine exacte) → 4 passed |
| 3 | Lint anti-service-role | Création de `lib/s4-scratch-not-inventoried.ts` contenant le littéral `SUPABASE_SERVICE_ROLE_KEY` | `service-role-inventory: ÉCHEC` — `non inventorié : lib/s4-scratch-not-inventoried.ts`, exit 1 | Suppression du fichier → `service-role-inventory: OK — 27 fichier(s) inventorié(s).` |
| 4 | Test de frontière — garde réelle (0147) | `mv supabase/migrations/0147_*.sql /tmp/`, `supabase db reset --local` (migration 0146→0148 direct) | `tests/rls/lot-f1-finances-v2-socle.rls.test.ts -t "refuse un lot d'une autre boutique du même tenant"` : 1 failed — `expected null not to be null` (`otherShopError` était `null`, l'écriture réussissait) | Migration restaurée, `db reset --local` (0147 réappliquée) → 1 passed |

**Contrôle à vide, obligatoire** :

| Mécanisme | Action | Résultat |
|---|---|---|
| Assertion de catalogue | `mv definer-authenticated-whitelist.json` hors du dépôt | 4 tests échouent (`ENOENT` sur `readFileSync`, capturé par `expect(() => ...).not.toThrow()` et par le parse JSON en amont) |
| Lint anti-service-role | `mv service-role-inventory.json` hors du dépôt | Le script lève `ENOENT` explicitement, exit 1 — pas de passage silencieux sur un inventaire vide |

Aucune modification temporaire ne subsiste — `git status --short` vérifié vide après chaque étape
et à la fin de la séquence complète.

## 8. Capacité lecture-seule contre la production

**Oui.** L'assertion de catalogue (Tâche 3) et le contournement Splinter 0028/0029 (Tâche 6)
réutilisent tous les deux `collectFunctions()`/`EXPOSED_SCHEMAS` de `scripts/lib/acl-snapshot.mjs`
— exactement le même module que `scripts/acl-production-probe.mjs`, déjà exécuté quotidiennement
en lecture seule contre la production sous le rôle `ci_schema_auditor` (Lot 4B, aucun privilège
au-delà des catalogues système + `supabase_migrations.schema_migrations`). Aucune requête nouvelle
introduite par ce lot ne touche une table applicative. **Câbler la liste blanche S4 dans
`acl-production-probe.mjs` lui-même est un prolongement possible, PAS fait dans ce lot** (hors
périmètre — la sonde production actuelle vérifie l'invariant absolu anon/service_role, pas encore
la liste blanche authenticated×SECURITY DEFINER).

## 9. `syncOrdersAction` — arbitrage à trancher, non tranché ici

Faits confirmés par lecture directe de `lib/actions/shopify.ts:43-64` :

- `syncOrdersAction = authActionClient` **seul** — aucun `requireRole(...)`. Tout membre
  authentifié du tenant, `agent` compris, peut l'invoquer.
- Appelle `syncShopOrders()` (`lib/shopify/shop-sync.ts:30`, écriture service-role) avec
  `merchantAccountId` dérivé de `getMerchantAccount()` (scopé serveur, jamais transmis par le
  client) et `shopId` dérivé de `getRequestStoreId()` (ne fait jamais confiance à un id forgé,
  CLAUDE.md).
- Reste atteignable uniquement depuis `/commandes`.
- La MÊME fonction `syncShopOrders()` est appelée ailleurs (`lib/actions/shops.ts:129`,
  `syncShopAction`) sous `requireRole('owner','manager')` — donc DEUX chemins d'appel vers le même
  code service-role, avec un statut de garde de rôle différent.

**Deux issues, ni l'une ni l'autre tranchée ici** :

- soit un `agent` **doit** pouvoir déclencher une synchronisation — alors l'écrire explicitement,
  l'inscrire à l'inventaire avec cette autorisation nommée, et la tester ;
- soit il ne doit pas — alors c'est un défaut de garde, à corriger dans un lot séparé (une
  migration n'est pas nécessaire ici, seulement l'ajout de `requireRole(...)` dans
  `lib/actions/shopify.ts` — mais reste hors périmètre de S4, qui ne fixe aucun défaut trouvé).

`lib/shopify/shop-sync.ts` est inscrit dans `service-role-inventory.json` avec `boundaryType:
"NONE"` et cette note, pour que l'inventaire ne mente pas sur son statut de garde.

## 10. `git diff --stat main..HEAD`

Capturé après le commit du présent rapport ET après un commit correctif (voir note ci-dessous) —
c'est l'arbre final réellement soumis aux deux runs CI du §11 :

```
 .github/workflows/ci.yml                                                     |   9 +
 docs/security/s4-enumeration-definer-authenticated.md                        |  91 +++++
 docs/security/s4-etape0-mesures.md                                           |  77 +++++
 docs/security/s4-rapport.md                                                  | 210 +++++++++++
 package.json                                                                 |   2 +
 scripts/lib/acl-snapshot.d.mts                                               |  80 +++++
 scripts/s4-check-service-role-inventory.mjs                                  |  76 ++++
 scripts/s4-run-splinter.mjs                                                  | 207 +++++++++++
 supabase/security/definer-authenticated-whitelist.json                      | 385 +++++++++++++++++++++
 supabase/security/search-path-mutable-admitted.json                         |  26 ++
 supabase/security/service-role-inventory.json                               | 191 ++++++++++
 supabase/security/splinter/0011_function_search_path_mutable.sql            |  49 +++
 supabase/security/splinter/0028_anon_security_definer_function_executable.sql |  76 ++++
 supabase/security/splinter/0029_authenticated_security_definer_function_executable.sql | 77 +++++
 tests/rls/s4-uncovered-definer-authenticated.rls.test.ts                     | 315 +++++++++++++++++
 tests/rls/security-definer-authenticated-whitelist.rls.test.ts              | 113 ++++++
 16 files changed, 1984 insertions(+)
```

**Note honnête sur le premier passage** : les deux premiers runs CI déclenchés (un `pull_request`,
un `workflow_dispatch`, sur l'arbre du commit `5b0766c`) ont échoué au `typecheck` — `tsc` refusait
l'import de `scripts/lib/acl-snapshot.mjs` (module `.mjs` sans déclaration, `allowJs: false` dans
`tsconfig.json`) depuis `tests/rls/security-definer-authenticated-whitelist.rls.test.ts` : 7
erreurs (module introuvable + `implicit any` en cascade), qui ont elles-mêmes fait échouer/sauter
tous les jobs `test-e2e` en aval (gate sur `typecheck`). Corrigé par l'ajout de
`scripts/lib/acl-snapshot.d.mts` (déclarations de types tenues à la main, synchronisées avec les
colonnes réellement retournées par `collectFunctions()`), commit `13cb66f`. Les deux runs relancés
après ce correctif (§11) portent sur cet arbre corrigé — les deux premiers essais, réels et non
supprimés de l'historique, ne comptent pas parmi les "deux runs verts" exigés par ce lot.

## 11. Deux runs CI verts, arbre identique

**Trouvaille non anticipée sur `workflow_dispatch`** : bien que le trigger ait été ajouté et
fonctionne (`gh workflow run` déclenche réellement un run), `gitleaks-action` se comporte
différemment selon le type d'événement — `pull_request` lance `gitleaks protect` (diff contre la
base, rapide), tandis que `workflow_dispatch` (comme `push`) lance `gitleaks detect` (scan complet
de l'historique). Le run `33870806652` (workflow_dispatch, arbre `6d69809`) a échoué sur ce scan
complet : `leaks found: 2`, deux occurrences de `const encryptionKey = '[REDACTED]'` — une chaîne
préexistante dans l'historique du dépôt, sans rapport avec S4 (aucun fichier de ce lot ne contient
`encryptionKey`), jamais détectée par le scan diff-only qu'utilisent les PR normales. **Ce n'est pas
un défaut S4** ; c'est une propriété structurelle de ce dépôt qui rend `workflow_dispatch`
inutilisable comme second déclencheur ici tant que cette dette gitleaks historique n'est pas
traitée séparément (hors périmètre de ce lot). Repli sur le motif déjà documenté par CLAUDE.md pour
ce cas exact : fermeture puis réouverture de la PR (`gh pr close 185` / `gh pr reopen 185`), qui
redéclenche un `pull_request` propre (scan diff-only).

**Les deux runs qui comptent, tous deux verts, arbre strictement identique :**

| # | Run ID | Déclencheur | `headSha` | Conclusion | Créé à |
|---|---|---|---|---|---|
| 1 | `33870795299` | `pull_request` (ouverture de la PR #185) | `6d69809b6f960e333cefb722ed9cb8ea3ffb0064` | success | 2026-09-04T12:02:36Z |
| 2 | `33871913731` | `pull_request` (fermeture/réouverture de la PR #185) | `6d69809b6f960e333cefb722ed9cb8ea3ffb0064` | success | 2026-09-04T12:16:03Z |

`headSha` identique confirmé par `gh run view --json headSha` sur les deux runs, et par
`git rev-parse HEAD` en local (`6d69809b6f960e333cefb722ed9cb8ea3ffb0064`, arbre
`3c78bb08bcec7df62584f822438d8e8f09b72cbd`). Aucun rejeu (`gh run rerun`), aucun commit vide entre
les deux — le premier run a réellement re-exécuté toute la suite (24 jobs, ~9 minutes), le second
aussi (mêmes 24 jobs, ~14 minutes).

**Runs écartés, avec raison** :
- `33870042825` (pull_request, arbre `5b0766c`) et `33870089828` (workflow_dispatch, arbre
  `5b0766c`) : `typecheck` en échec (import `.mjs` non typé, `allowJs: false`) — corrigé par le
  commit `13cb66f`, voir §10.
- `33870806652` (workflow_dispatch, arbre `6d69809`) : `test-rls` en échec sur
  `tests/rls/shopify-reconcile-cursor.rls.test.ts` (`expected 1 to be 2`), un test préexistant sans
  rapport avec S4, vert sur le run `33870795299` exécuté sur le MÊME arbre à la même minute — flake,
  pas une régression. `gitleaks` en échec sur ce même run pour la raison structurelle décrite
  ci-dessus (scan complet vs scan diff).
