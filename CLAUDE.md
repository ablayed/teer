# CLAUDE.md

> `AGENTS.md` mirrors this file. If they diverge, this file wins.

**Latest applied migration: `0078`** (prod + local; RPC `get_loss_analytics_joins`, security invoker, tenant-scopée, jointures order_line/customer/driver côté SQL).

**Dernières features en prod (main) :** invitation collaborateur (#26) · garde-fou anti-prod seeds E2E `assertLocalSupabase` (#29) · **commandes : filtre période + boutique, groupement par date, recherche instantanée, dropdown actions (#30)**. La création manuelle de commande utilise **Paradigm A** (cf. gotcha « Données serveur post-mutation ») : lecture serveur + injection state, jamais `router.refresh()`/navigation.

**Vague 3 — Support & Onboarding (mergée #35) :** page `/assistant` renommée « Aide » (HelpCircle nav) · FAQ searchable 50 entrées 10 catégories filtrage rôle (agent/manager/owner) · articulation FAQ → assistant (CTA 0-résultats) · WhatsApp/email support conditionnels (`NEXT_PUBLIC_SUPPORT_WHATSAPP` / `NEXT_PUBLIC_SUPPORT_EMAIL` optionnels sans défaut) · feedback table `0075` + `submitFeedbackAction` + Resend best-effort · checklist onboarding 5 étapes sur `/tableau` (localStorage dismiss, owner/manager uniquement).

**Milestone 2 — Refonte auth (mergée #38) :** split-screen `BrandPanel` partagé (connexion + onboarding) · `PasswordField` reveal/masquer · indicateur force MDP 0–5 critères · onglets Connexion/Inscription dans `/connexion?mode=` · bandeau idle `?reason=idle` (`<output role=status>`) · `role="alert"` sur toutes les erreurs · vidage MDP après échec sign-in · onboarding redesign : barre de progression, `auth-step-enter` CSS, confirmation étape 1, écran bienvenue Peak-End · navigation post-onboarding via `router.push('/tableau')` (Router Cache vide → déterministe). E2E auth à écrire dès merge PR #37 — cf. `docs/dette-e2e-auth.md`.

**Vague 1 self-service compte (branche feat/vague1-securite) :** onglet Sécurité dans `/parametres` — changement mot de passe (réauth applicative `signInWithPassword` + `updateUser`), changement email (double confirmation Supabase `double_confirm_changes=true`), déconnexion automatique après 2h d'inactivité (modal d'avertissement 2 min avant). Zéro migration SQL. Env : `IDLE_TIMEOUT_MS` / `IDLE_WARNING_MS` (défaut 7 200 000 / 120 000 ms ; debug hook `window.__teerIdleDebug.triggerWarning()` en non-prod pour E2E).

**Lot 3 — Analyses : migration mobile (mergée #47) :** les 6 tables larges (scorecard, produits, zones, livreurs, raisons, refuseurs) passent en `sr-only md:not-sr-only md:table` (desktop inchangé) + cartes empilées `md:hidden aria-hidden="true"` en dessous — la table `sr-only` reste l'unique équivalent accessible (screen reader + `getByRole('cell')` E2E), les cartes sont une redondance visuelle pure. Fix overflow du formulaire période local à `/analyses` (classes `w-full/sm:w-auto/min-w-0/max-w-full`, **sans** `flex`/`flex-col` — voir gotcha ci-dessous). `.first()` ajouté sur 3 `getByText` d'`analytics.spec.ts` pour lever l'ambiguïté du double rendu volontaire table+carte.

**Analyses — Bug 2 gros compte : 400 Bad Request (mergée #50, migration `0078`) :** `/analyses` échouait (400, pas timeout : 1,54 s / 30 s) sur les gros comptes (~1000 commandes) car `getLossAnalyticsAction` passait ~1000 UUID (`order_line.order_id`) + ~800 (`customer.id`) **dans l'URL** via `.in()` → URL au-delà de la limite du gateway PostgREST. Fix : RPC `get_loss_analytics_joins` (POST body, zéro UUID en URL) partant de la fenêtre marchand+dates, jointures order_line/customer/driver côté SQL, 3 clés toujours en tableaux. `computeLossAnalytics` **inchangé** (mapping `.map()` identique) → chiffres strictement identiques (visual desktop+mobile 0 diff). `handleServerError`+Sentry ajoutés en durable (capture des exceptions avalées par next-safe-action).

**Tableau — « Priorités à traiter » (mergée #55) :** la section « Urgences du jour » (`OrderExceptionsGrid`) est renommée et refondue : ses 4 lignes passaient d'un décompte non borné (parfois tout l'historique, ex. 956 pour « À appeler ») à une fenêtre 7j cohérente avec la carte KPI (`get_dashboard_kpi`, migration 0076). Nouvelle fonction `getPriorityCounts` (`lib/actions/dashboard.ts`) : À appeler = `cod_status=A_APPELER` + `created_at` 7j ; En cours de livraison / Annulées-Retours = dernière `order_state_transition` pertinente (`EN_LIVRAISON` / `ANNULEE`,`REFUSEE`) dans les 7j (pas de date de commande fiable pour ces états). Garde compteur=liste : `orderMatchesPeriod` (`lib/actions/orders.ts`) devient **view-aware** — `a-appeler` filtre sur `created_at` (au lieu de `orderQueueDate`), `en-livraison`/`annulees-retours` filtrent sur `order_state_transition.to_status`, **toutes les autres vues gardent `orderQueueDate` inchangé** (fix ciblé, pas de changement global de la période `/commandes`). `buildOrderViewHref` accepte désormais `{period, shopId}`. Libellés migrés vers i18n (`tableau.blocks.exceptions.*`).

**PeriodPicker unifié — style Shopify (PR #52) :** un seul `<PeriodPicker>` (`components/period-picker/`) remplace `components/ui/period-controls.tsx` (commandes+finances) ET le `<form>` inline d'`/analyses` — trigger compact → **Popover ≥ md (`@radix-ui/react-popover`) / bottom-sheet Vaul < md**, corps partagé `PeriodPickerBody` (presets 1 tap + section « Personnalisé » = inputs `type=date` natifs Du/Au + « Appliquer », **pas de calendrier** react-day-picker : retiré car les inputs natifs suffisent). État via **nuqs `useQueryStates`** (`NuqsAdapter` monté dans `(app)/layout`) qui fusionne les params **en place** → n'écrit que `period`/`from`/`to`, préserve `q`/`shop`/`vue`/`tab`/etc. (corrige l'ancien bug « perte de from/to »). **Tokens URL inchangés** (`today,yesterday,7j,30j,90j`) + ajout `month` (« Ce mois-ci ») ; presets configurables par page (défaut = set canonique complet `PERIOD_PRESETS` de `lib/periods/date-range.ts`). Lecture serveur inchangée (`resolvePeriodRange` étendu à `month` ; `/analyses` n'a plus de résolveur dupliqué). Anti-hydratation : trigger seul avant `mounted`, overlay monté ensuite. Namespace i18n partagé `periodPicker`. Dep `date-fns` (libellé de plage du trigger). Deps ajoutées : `nuqs`, `@radix-ui/react-popover`, `date-fns`.

## Commands

```bash
pnpm test:rls     # vitest run tests/rls — needs a running Supabase stack (SUPABASE_URL/ANON_KEY/SERVICE_ROLE_KEY via .env.test)
pnpm test:e2e     # playwright test — Playwright manages pnpm dev itself; do NOT pre-start dev
pnpm db:types     # regenerate lib/supabase/database.types.ts from the linked project
```

Single unit test: `pnpm vitest run tests/unit/orders/<file>.test.ts` or `pnpm vitest -t "<test name>"`.
Single e2e spec: `pnpm exec playwright test tests/e2e/<spec>.ts --project=chromium`.

**Ports 54321-54324 are shared with another local project — stop it before `supabase start`.**

## Engineering rules

1. **Invent NOTHING.** No table, column, function, action, route, or component that doesn't exist in the repo. Missing name → STOP and flag it.
2. **Migration → STOP.** Write the `.sql` file and stop. Developer runs `pnpm exec supabase db push` then `pnpm db:types`. You never run `db push`.
3. **Schema to prod BEFORE code.** No TS line references a table/column until its migration is confirmed applied in prod.
4. **One commit per deliverable.** French message prefixed by phase (e.g. `phase3:`). No opportunistic refactors bundled in.
5. **Sanity loop before every commit:** `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm build`, plus `pnpm test:rls` **non-skipped**. Never commit red.
6. **`performTransition` is the ONLY write gate for order state.** No applicative `.from('orders').update(...)` on state. The client never decides a transition; it only renders the `allowedActions` the server returns.
7. **Stock is a SIDE EFFECT, never a precondition.** An unresolved order line never fails a transition — skip its stock movement.
8. **RLS discipline:** RLS FORCE + deny-by-default; separate policies per operation; every `UPDATE` policy has `WITH CHECK`; new columns start nullable. `unit_cost`/margin hidden from `agent` at column level.
9. **Never switch agents on a dirty tree.** Commit + push first; `git status` must be empty.

## Architecture

### next-safe-action layering (`lib/actions/safe-action.ts`)

All mutations go through `next-safe-action`, never raw route handlers.
- `actionClient` — base, requires `{ actionName, section }` metadata.
- `authActionClient` — adds `ctx.user` + `ctx.supabase` (throws `UNAUTHENTICATED`).
- `requireRole(...roles)` — adds `ctx.member` (`{ id, merchantAccountId, role }`); throws `FORBIDDEN`.

Server errors flatten to opaque strings (`UNEXPECTED_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`). Import env from `lib/env.ts`, never `process.env` directly.

### Three-layer transition stack (keep all three in sync on every lifecycle change)

1. `lib/domain/order-state-machine.ts` — legal transitions between `cod_status` values; `canTransition`/`assertTransition`.
2. `lib/domain/order-transition-actions.ts` — maps 11 user actions (`confirmer`, `livrer`, …) to 4D dimension patches via `transitionCatalog`; RBAC per action.
3. `lib/actions/transitions.ts` — `performTransitionForContext` orchestrates: role check → load order → `canTransition` → `transition_order` Postgres RPC (atomic: dimensions + stock movements in one tx) → reload → write `audit_log` (service-role) → `revalidatePath` → return `{ order, allowedActions }`.

The actual write is in the **`transition_order` Postgres function**, not TS. When changing the lifecycle, update all three TS layers **and** the RPC **and** RLS policies together.

**`cod_status` is trigger-derived** (`derive_legacy_cod_status`, `BEFORE INSERT OR UPDATE`, migration `0023`). Write the four dimensions (`order_state`, `call_state`, `delivery_state`, `cash_state`); the trigger derives `cod_status`. **Never write `cod_status` directly.**

Derivation priority (top→bottom): `delivery_state ∈ {failed,returned}` or `order_state=returned` → `REFUSEE` · `order_state=cancelled` → `ANNULEE` · `delivery_state=delivered` → `LIVREE` · `delivery_state ∈ {out_for_delivery,assigned}` → `EN_LIVRAISON` · `delivery_state=scheduled` → `PROGRAMMEE` · `call_state=validated` → `CONFIRMEE` · `call_state=callback` → `TENTEE` · else → `A_APPELER`.

### Two Supabase clients

- `lib/supabase/server.ts` — `createSupabaseServerClient`, cookie-based, **respects RLS** — use in all actions and RSC.
- Service-role admin client — created inline in `transitions.ts`, **bypasses RLS** — only for audit writes. Never use elsewhere.
- `lib/supabase/client.ts` — browser client.

### Roles and agent write scope

Three roles: `owner`, `manager`, `agent`. Capabilities checked in TS (`lib/team/permissions.ts`) AND enforced in Postgres RLS via `current_member_role(merchant_account_id)`. Agents see **all** tenant orders (no row filter); RLS restricts their **write scope** only: `orders_update` `WITH CHECK` limits agent to `cod_status ∈ {TENTEE, CONFIRMEE, PROGRAMMEE, EN_LIVRAISON}`. Because `cod_status` is trigger-derived, the post-trigger row must satisfy that `WITH CHECK`.

### Analytics pages — Suspense + keyed skeleton (non-negotiable)

Every data-heavy analytics page must: (1) keep top-level `await` minimal; (2) wrap each heavy block in `<Suspense fallback={<AnalyticsSkeleton />}>`; (3) **key the Suspense on the searchParams that change the view** (`key={`${tab}-${period}`}`). A `?tab=` or `?period=` change does NOT trigger `loading.tsx` (same route segment) — without a keyed Suspense the old view freezes. Reference: `app/(app)/finances/page.tsx`.

## Critical gotchas

- Order status legacy column is `cod_status` (text), trigger-derived, **never written directly** — see Architecture. Order total column is `total_amount` (numeric).
- All money is stored as minor-unit bigint (FCFA, 0 decimals). Never render a raw amount — always pass through `formatMoney(amount)`. The cash field is `cash_collectable_minor` (bigint).
- **`formatMoney` intentionally ignores `orders.currency`** and always displays « F CFA » rounded to integer. Do not re-introduce currency reads from `orders.currency`.
- **Migrations: write the file and stop. Schema to prod before code.**
- Every new RLS `UPDATE` policy includes a `WITH CHECK`. New columns start nullable.
- The client never decides a transition. `performTransition`/`transition_order` validate preconditions and return `allowedActions`; the UI only renders what the server returns.
- `orders.items_summary` (jsonb) holds line items; since Phase 3a it also captures Shopify `product/variant/sku` ids per line (older orders have free-text titles only → resolved best-effort). `orders.source` distinguishes origin.
- `product.unit_cost` is `bigint NOT NULL DEFAULT 0` — a product never costed equals 0, not null. Treat `unit_cost=0 AND frozen COGS=0` as "cost unknown"; never display a silent 100% margin.
- **`SECURITY DEFINER` role gates must be NULL-safe.** `current_member_role()` returns NULL for non-members; `NULL NOT IN (...)` is not TRUE — the gate is silently skipped → cross-tenant leak. Always guard as `v_role IS NULL OR v_role NOT IN (...)`.
- **Données serveur post-mutation : JAMAIS via `router.refresh()`/navigation (Paradigm A).** Même classe que PR #17 (drivers:381) : exposer une donnée serveur fraîche après une mutation à travers un RSC (navigation/`router.refresh()`) la rend **périmée ~20 % en build de prod** (Router Cache client servi avant invalidation). Fix prouvé déterministe (30/30) : une **action serveur de relecture** (même source que le RSC) + **injection dans le state client**. Réf. création manuelle de commande (`new-order-form` notifie `orders-workspace` via `OrdersBoardProvider` → relit `getOrdersPageData` → réinjecte). Pièges au passage : (a) le refresh implicite que Next déclenche après *toute* server action re-render le RSC → ne pas purger l'état injecté sur un changement de prop instable ; (b) `resolvePeriodRange` met `to: now` au render → un `dateTo` capturé AVANT la mutation exclut la ligne (`orderMatchesPeriod`) → relire avec une borne haute fraîche ; (c) visibilité read-after-write intermittente → poll borné jusqu'à voir l'id créé.
- **`upgrade-insecure-requests` in CSP must be prod-only.** WebKit applies it to `http://localhost` → blank page in all iphone-14 E2E tests. Chromium exempts loopback; WebKit does not.
- **Do not pre-start `pnpm dev` before `pnpm test:e2e`.** Playwright manages the webServer. Pre-starting causes login failures (`.env.local` vs `.env.test` Supabase credential mismatch).
- **Validation finale E2E build-prod (2026-06-28)** : `e2e-zero-flake.yml` prouve `repeat-each=25` vert sur `chromium`, `pixel-7`, `iphone-14` avec `retries=0`. Post-validation, `.github/workflows/e2e-prod.yml` et le warm-up `globalSetup` ont été retirés. Restent en place : `expect.timeout 10s`, iphone-14 `timeout 90s`, `webServer.timeout 180s`, `retries: 1`, `trace: on-first-retry`.
- **Migration table → cartes mobile : `sr-only`, jamais `hidden md:table`, si l'E2E utilise `getByRole` sur la table.** `hidden`/`display:none` retire les cellules de l'arbre d'accessibilité → `getByRole('row'|'cell')` ne trouve plus rien sous `md` (prouvé sur `drivers.spec.ts`, PR #46). `sr-only md:not-sr-only md:table` (desktop inchangé, table clip-visuelle sous `md`) préserve `getByRole` sans toucher le test. Cartes mobiles en `md:hidden aria-hidden="true"` — la table sr-only est l'équivalent accessible complet, ne pas dupliquer l'annonce screen-reader. Si des `getByText(...)` (sans scoping de rôle) matchent la même valeur dans la table et la carte, ajouter `.first()` (pattern déjà présent pour `seeded.productTitle` dans `analytics.spec.ts`) — ce n'est pas affaiblir le test, la donnée vérifiée reste identique.
- **Un fix d'overflow mobile peut casser le desktop s'il change `display`/`flex`, pas seulement `width`.** Le fix `period-controls.tsx` (#41) utilise `flex flex-col` ; réutilisé tel quel sur le formulaire local d'`/analyses` (#47), il a fait passer le layout desktop de 2 lignes à 1 (26402 px de diff CI, gate 0-diff violé). Cause : `flex`/`flex-col` change le modèle de boîte, pas juste la largeur. Fix : garder `block`/`space-y-*` (comportement flex-item d'origine côté parent `flex-wrap` préservé) et n'ajouter que `w-full/sm:w-auto/min-w-0/max-w-full` pour la largeur. Vérifier le nombre de lignes du wrap desktop avant de pousser, pas seulement l'absence d'overflow mobile.
- **Gros `.in(uuidArray)` = URL PostgREST trop longue → 400 sur les gros tenants uniquement.** `.in('col', ids)` sérialise les UUID dans l'URL (GET). ~1000 UUID ≈ 37 KB → au-delà de la limite du gateway → **400 « Bad Request »** (immédiat, pas un timeout ; le compte léger passe → bug invisible en dev/seed). Prouvé sur `getLossAnalyticsAction` (#50, Bug 2 analyses). Fix : une **RPC** (`supabase.rpc(...)` = POST body JSON, aucune limite d'URL) qui part de la **fenêtre marchand+dates** et fait la jointure côté SQL — **ne jamais** passer un gros tableau d'UUID en paramètre d'URL. Si un paramètre tableau est indispensable : RPC à `p_ids uuid[]` via `= any(...)` (POST), pas `.in()`. Contrat de sortie = colonnes consommées par le calcul JS (mapping `.map()` inchangé → chiffres identiques).
- **`supabase db push` ne touche QUE le linked/remote (prod) — le stack local peut dériver.** Après un `db push`, le local reste à sa dernière migration rejouée (vu #50 : prod à jour mais **local resté à `0075`** alors que `0076/0077/0078` étaient en prod). Symptôme : `supabase.rpc('...')` renvoie **`PGRST202` (function not found in schema cache)** en local → l'action tombe en `ok:false` → E2E/visual/RLS rouges (ex. graphe `/analyses` absent). Fix : `pnpm exec supabase migration up --local` (non destructif, applique les migrations en attente au local) **avant** de lancer les tests locaux. `pnpm db:types` régénère depuis le linked, pas le local → les types peuvent être en avance sur le schéma local.
- **`update-visual-baselines` pousse avec `GITHUB_TOKEN` → son commit ne relance PAS `ci.yml` (garde anti-récursion GitHub).** Le workflow régénère les `*-linux.png` et pousse un commit bot ; ce commit reste en `action_required` côté CI et le HEAD de la PR n'a aucun run E2E/visual frais → la PR paraît **rouge** alors que les baselines sont bonnes. Fix : **fermer/rouvrir la PR** (`gh pr close 52 && gh pr reopen 52`) → événement `reopened` → run `ci.yml` propre sur le nouveau HEAD. Toujours refaire tourner la CI ainsi après une régénération de baselines.
- **nuqs `withDefault` efface le param à sa valeur défaut → conflit avec une persistence localStorage.** Sur `/finances`, `FinancePeriodPersistence` restaure le dernier `period` du localStorage quand l'URL n'en a pas ; si le PeriodPicker efface `period` en sélectionnant le défaut (`30j`), la persistence le ré-injecte aussitôt → **le défaut devient inatteignable**. Fix (`use-period-params.ts`) : ne PAS utiliser `withDefault` pour l'écriture — écrire toujours le token explicite (y compris `30j`) ; répliquer le défaut serveur côté lecture via `period ?? '30j'`.
- **Auditer TOUS les E2E qui cliquent un filtre avant de le refondre — le grep par pattern rate les libellés en dur.** La refonte PeriodPicker (#52) a cassé `shop-filter.spec.ts` (« sélecteur boutique + période coexistent ») raté au grep initial car il ciblait le lien preset par libellé littéral `"Aujourd'hui"` (pas `period=`/`getByLabel`). Avant de supprimer un filtre : grep les **libellés** des presets/onglets (`"Aujourd'hui"`, `"Hier"`, `"7 derniers jours"`…), pas seulement les params d'URL. Distinguer un vrai clic de filtre d'un `getByRole('heading', name:"Aujourd'hui")` (titre de groupement par date, sans rapport).
- **Un seed E2E qui écrit l'état d'une commande en direct (`admin.from('orders').insert/update`) ne peuple JAMAIS `order_state_transition`.** Seul `transition_order` (RPC) y insère une ligne. Si une vue/compteur se met un jour à filtrer sur `order_state_transition.to_status` (ex. #55, lignes « En cours de livraison »/« Annulées-Retours » du Tableau bornées 7j sur la dernière transition), tout seed qui écrit l'état final directement fait disparaître silencieusement ces commandes du résultat attendu — symptôme : `getByRole('button', {name: /^X \(N\)$/})` introuvable, pas une erreur explicite. Trouvé et corrigé dans 3 fixtures différentes (`orders-transitions.spec.ts`, `visual-fixtures.ts`, `orders-pagination-verify.spec.ts`) lors du même lot — **grep systématiquement `admin.from('orders').insert` dans tous les E2E avant d'ajouter un filtre basé sur une transition**, pas seulement les fixtures déjà connues.
- **CI locale non fiable au-delà de quelques tests : ne JAMAIS juger `pnpm test:e2e` complet en local, seule la CI GitHub (Linux, à froid) fait foi.** `reuseExistingServer: !process.env.CI` fait que Playwright réutilise le `next dev` déjà lancé localement ; après plusieurs dizaines de tests/heures d'utilisation dans une session, ce process dev-mode dégrade (timeouts en cascade sur des specs sans rapport) — symptôme repéré sur ce repo : des tests passant isolément se mettent à échouer en `1.0m` (timeout) une fois lancés après ~50 tests dans le même run. Confirmé en tuant le process et en relançant le test isolé (26s, vert). Toujours valider via les 3 jobs CI (`chromium`/`pixel-7`/`iphone-14`), jamais via un run local complet.
- **Un diff visuel `toHaveScreenshot` peut être un flake ponctuel même sur un vrai changement de label.** PR #55 : le label du Tableau change (« Exceptions a traiter » → « Priorités à traiter »), un premier run CI a montré 2 % de diff sur `iphone-14` (juste au-dessus du seuil `maxDiffPixelRatio: 0.01` — même diff absolu ~2700px, ratio plus élevé sur le plus petit viewport) ; une regénération de baseline immédiate après a rapporté « No baseline changes to commit » (rendu identique à l'existant), et le run CI suivant est passé 18/18 sans toucher aux baselines. Ne pas re-générer les baselines au premier rouge visuel : reconfirmer par un second run avant de conclure à un vrai diff.

## Dette E2E residuelle

**(a) Lot build-prod cloture.** La preuve finale `3 x 25` sur `chromium`, `pixel-7` et `iphone-14` a valide la decision B sur `main`, puis le workflow `e2e-prod.yml` et le warm-up `globalSetup` ont ete retires en cleanup post-validation merge sur `main` (`e45e6b1`). Ne pas reintroduire ces filets sans nouvelle preuve CI documentee.

**(b) `qa-prelaunch versement` — résolu PR stabilisation-e2e-flaky.** Cause : `fill()` sur spinbutton React contrôlé ne déclenche pas `onChange` sous WebKit iphone-14 → formulaire soumis avec 0. `cash_collectable_minor = 50000` prouvé correct en DB (assertion ligne 830 passe) — ce n'est PAS un bug applicatif. Fix : `click({clickCount:3}) + pressSequentially()` + guard `toHaveValue()` avant submit.

**(c) Audit fill() → pressSequentially à étendre.** Le fix ci-dessus s'applique à tout spinbutton/input numérique React contrôlé dans les specs E2E. À auditer lors du prochain lot E2E : `drivers.spec.ts` (`getByPlaceholder('10').fill('15')`), et tout autre `fill(someNumber)` sur un `<input type="number">` dans les specs iphone-14. Pattern à adopter partout : `click({clickCount:3}) + pressSequentially()`.

---
*This file supersedes any implicit understanding. If in doubt between this file and an ad-hoc instruction, ask the developer.*
