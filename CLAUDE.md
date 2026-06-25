# CLAUDE.md

> `AGENTS.md` mirrors this file. If they diverge, this file wins.

**Latest applied migration: `0075`** (prod + local; table `feedback`, RLS FORCE INSERT tenant-scoped SELECT owner-only).

**Dernières features en prod (main) :** invitation collaborateur (#26) · garde-fou anti-prod seeds E2E `assertLocalSupabase` (#29) · **commandes : filtre période + boutique, groupement par date, recherche instantanée, dropdown actions (#30)**. La création manuelle de commande utilise **Paradigm A** (cf. gotcha « Données serveur post-mutation ») : lecture serveur + injection state, jamais `router.refresh()`/navigation.

**Vague 3 — Support & Onboarding (mergée #35) :** page `/assistant` renommée « Aide » (HelpCircle nav) · FAQ searchable 50 entrées 10 catégories filtrage rôle (agent/manager/owner) · articulation FAQ → assistant (CTA 0-résultats) · WhatsApp/email support conditionnels (`NEXT_PUBLIC_SUPPORT_WHATSAPP` / `NEXT_PUBLIC_SUPPORT_EMAIL` optionnels sans défaut) · feedback table `0075` + `submitFeedbackAction` + Resend best-effort · checklist onboarding 5 étapes sur `/tableau` (localStorage dismiss, owner/manager uniquement).

**Vague 1 self-service compte (branche feat/vague1-securite) :** onglet Sécurité dans `/parametres` — changement mot de passe (réauth applicative `signInWithPassword` + `updateUser`), changement email (double confirmation Supabase `double_confirm_changes=true`), déconnexion automatique après 2h d'inactivité (modal d'avertissement 2 min avant). Zéro migration SQL. Env : `IDLE_TIMEOUT_MS` / `IDLE_WARNING_MS` (défaut 7 200 000 / 120 000 ms ; debug hook `window.__teerIdleDebug.triggerWarning()` en non-prod pour E2E).

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
- **E2E CI stabilisation (PR #24, juin 2026)** : globalSetup warm-up des 10 routes principales + `expect.timeout 10s` + iphone-14 `timeout 90s` + `webServer.timeout 180s`. Job test-e2e vert : 191 passed, 0 failed, 4 flaky rattrapés par `retries: 1`.

## Dette E2E ouverte

**(a) Cause racine non résolue — compilation on-demand next dev en CI.** Le warm-up pré-compile les routes statiques mais Next.js dev évince son cache sous pression mémoire et recompile pendant les specs. Les routes dynamiques `/commandes/[id]`, `/api/rapport`, `/api/shopify/webhooks` ne sont pas warm-upées. Le vrai fix : généraliser `next build + next start` (pattern de `e2e-prod.yml`) à tout le job CI — **MAIS** ça rouvre le piège UIR/WebKit (`upgrade-insecure-requests` casse WebKit sur `http://localhost` → blank page). **CE FIX EST DÉJÀ CONSTRUIT, rangé pour reprise** : branche `infra/e2e-build-prod` (bascule `ci.yml` build-prod 3 cibles + `NEXT_PUBLIC_DISABLE_UIR=1` baké qui neutralise UIR en test + fix seed pagination 0062 + `expect.poll`), note `docs/dette-e2e-build-prod.md`, filet `backup/tangled-stack-2026-06-23` + `wip/socle-uir`. À rebaser sur main (après `wip/socle-uir`) puis pousser. **Symptôme de cette dette au merge #30** : `test-e2e` rouge sur des specs **migrantes** (invitation/drivers/analytics/products/qa-prelaunch, et `orders-transitions:532`/`:607` — transitions, pas la feature) avec durées 1.0–1.5 min = timeouts de compil à froid ; non rattrapés de façon fiable par `retries:1` sous charge.

**(b) `qa-prelaunch versement` — résolu PR stabilisation-e2e-flaky.** Cause : `fill()` sur spinbutton React contrôlé ne déclenche pas `onChange` sous WebKit iphone-14 → formulaire soumis avec 0. `cash_collectable_minor = 50000` prouvé correct en DB (assertion ligne 830 passe) — ce n'est PAS un bug applicatif. Fix : `click({clickCount:3}) + pressSequentially()` + guard `toHaveValue()` avant submit.

**(c) Audit fill() → pressSequentially à étendre.** Le fix ci-dessus s'applique à tout spinbutton/input numérique React contrôlé dans les specs E2E. À auditer lors du prochain lot E2E : `drivers.spec.ts` (`getByPlaceholder('10').fill('15')`), et tout autre `fill(someNumber)` sur un `<input type="number">` dans les specs iphone-14. Pattern à adopter partout : `click({clickCount:3}) + pressSequentially()`.

---
*This file supersedes any implicit understanding. If in doubt between this file and an ad-hoc instruction, ask the developer.*
