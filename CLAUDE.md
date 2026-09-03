# CLAUDE.md

> `AGENTS.md` points here. This file is the single source of truth. If in doubt between this file and an ad-hoc instruction, ask the developer.

> **Migration tracker attestation (2026-08-29) :** dernière migration confirmée appliquée en production, par lecture directe de `supabase_migrations.schema_migrations` sur la base liée : **`0147`** (garde boutique de `correct_purchase_lot_cost`, Lot S1). `0142`/`0143` (schéma canonique L1, jeton webhook opaque), confirmés non déployés au 2026-08-24, sont désormais présents dans le tracker de la base liée — reclassés déployés à cette date. Ne jamais présumer l'application d'une migration sans preuve : `db push` réussi attesté par le porteur, ou lecture directe du tracker/catalogue sur la base réellement concernée (règle #4).

## Commands

```bash
pnpm test:rls     # vitest run tests/rls — needs a running Supabase stack (SUPABASE_URL/ANON_KEY/SERVICE_ROLE_KEY via .env.test)
pnpm test:e2e     # playwright test — Playwright manages pnpm dev itself; do NOT pre-start dev
pnpm db:types     # regenerate lib/supabase/database.types.ts from the linked project
$env:VERCEL_ENV='preview'; pnpm build   # LOCAL BUILD — see box below, do not run pnpm build bare
```

> ⚠️ **`pnpm build` bare, locally, WILL fail — this is not a real failure, run it as shown above.** `next build` hardcodes `NODE_ENV=production`. `isProductionEnvironment` (`lib/security/environment-validation.ts`) falls back to `NODE_ENV` only when `VERCEL_ENV` is unset — on a real Vercel build `VERCEL_ENV` is always set, but a local shell never sets it, so the guard throws `Unsafe production environment configuration`. **Not a secrets problem — do not hunt for `.env.local` values.** Set `$env:VERCEL_ENV='preview'` (PowerShell) / `VERCEL_ENV=preview` (bash) first. Unrelated to dette (h) below (`.env.local` vs `.env.test` for `E2E_PROD_BUILD=1`, a different env-baking problem).

Single unit test: `pnpm vitest run tests/unit/orders/<file>.test.ts` or `pnpm vitest -t "<test name>"`.
Single e2e spec: `pnpm exec playwright test tests/e2e/<spec>.ts --project=chromium`.

**Ports 54321-54324 are shared with another local project — stop it before `supabase start`.**

**Never enchaîner `pnpm test:rls` puis `pnpm test:e2e` sur le même stack local sans `supabase db reset --local` entre les deux** — la suite RLS laisse des centaines de tenants qui font flaker l'E2E de façon non reproductible (attribué à tort à du code, en réalité à la propreté de la base).

**CI locale non fiable au-delà de quelques dizaines de tests : ne JAMAIS juger `pnpm test:e2e` complet en local.** `reuseExistingServer` fait dégrader le `next dev` réutilisé après usage prolongé (timeouts en cascade sur des specs sans rapport). Seule la CI GitHub (Linux, à froid, 3 jobs `chromium`/`pixel-7`/`iphone-14`) fait foi.

**`supabase db push` ne touche QUE le linked/remote — le stack local peut dériver.** Symptôme : `PGRST202 function not found` en local après un push. Fix : `pnpm exec supabase migration up --local` avant de lancer des tests locaux. `pnpm db:types` régénère depuis le linked, pas le local.

**`supabase gen types` produit un style non conforme biome — lancer `pnpm format` après `pnpm db:types`, systématiquement**, sinon `lint` échoue en CI sur `database.types.ts` avec un diff massif. Utiliser exclusivement le CLI Supabase **`2.102.0`** (figé sans plage dans `package.json`/CI) — une autre version reformate massivement sans changement de schéma ; ne jamais committer ce bruit.

**`database.types.ts` doit rester intégralement généré** ; le seul écart légitime (`shop_id` optionnel en `Insert` sur les 12 tables à trigger `assign_default_store_context`, car le générateur ne voit pas les triggers) est réappliqué automatiquement par `scripts/apply-database-types-overrides.mjs`, branché sur `pnpm db:types`. Ne jamais retoucher le fichier à la main.

## Engineering rules

1. **Invent NOTHING.** No table, column, function, action, route, or component that doesn't exist in the repo. Missing name → STOP and flag it.
2. **Migration → STOP.** Write the `.sql` file and stop. Developer runs `pnpm exec supabase db push` then `pnpm db:types`. You never run `db push`.
3. **Schema to prod BEFORE code.** No TS line references a table/column until its migration is confirmed applied in prod.
4. **Tracker migrations: "prod" only after proof.** A migration is marked applied in prod only after explicit confirmation of a successful `db push` by the developer and/or a direct read of `supabase_migrations.schema_migrations` on the linked DB. CI runs `supabase db reset --local`; it never pushes to prod.
5. **One commit per deliverable.** French message prefixed by phase (e.g. `phase3:`). No opportunistic refactors bundled in.
6. **Sanity loop before every commit:** `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm build`, plus `pnpm test:rls` **non-skipped**, plus `pnpm security:acl-baseline:check` (Lot 4A, see below). Never commit red.
7. **`performTransition` is the ONLY write gate for order state.** No applicative `.from('orders').update(...)` on state. The client never decides a transition; it only renders the `allowedActions` the server returns.
8. **Stock is a SIDE EFFECT, never a precondition.** An unresolved order line never fails a transition — skip its stock movement.
9. **RLS discipline:** RLS FORCE + deny-by-default; separate policies per operation; every `UPDATE` policy has `WITH CHECK`; new columns start nullable. `unit_cost`/margin hidden from `agent` at column level.
10. **Never switch agents on a dirty tree.** Commit + push first; `git status` must be empty.
11. **Any `revoke` on a function must name every role explicitly (`revoke all on function ... from public, anon;`), both together, always.** On Supabase, `revoke ... from public` alone is a no-op (grants are made nominally to `anon`/`authenticated`/`service_role`, not via `PUBLIC`); a bare `DROP`+`CREATE` separately reopens `EXECUTE` to `PUBLIC`. Verify with `pg_proc.proacl`/`has_function_privilege`, never by the presence of a `revoke` statement in the SQL text.
12. **Before revoking `GRANT EXECUTE` on any function, list every SQL/TS caller and determine its *effective role*.** A `SECURITY INVOKER` function runs as the final caller's role, not its owner's — missing this produced the 0134/0135 production incident (see below).
13. **Consult `docs/lexique-microcopie.md` before writing or restoring any user-facing string.** It carries decisions already made and closed — a forbidden notion pulled back in from a design-research doc, or a register choice (vouvoiement, sans exception) — with the reasoning behind each. Add an entry there, not just a fix in place, whenever a similar decision is made in the future.
14. **Toute capture/vérification navigateur authentifiée doit utiliser un compte et une boutique de test dédiés, jamais le compte propriétaire.** Dev et prod partagent la même base — une session authentifiée réelle peut déclencher une action métier (mutation, écriture, effet de bord) qui touche des données réelles. Ne jamais se connecter avec des identifiants fournis à la volée sans confirmer explicitement qu'ils pointent vers un compte/boutique de test ; si le statut du compte est incertain, demander avant de s'authentifier.

## Architecture

### next-safe-action layering (`lib/actions/safe-action.ts`)

All mutations go through `next-safe-action`, never raw route handlers.
- `actionClient` — base, requires `{ actionName, section }` metadata.
- `authActionClient` — adds `ctx.user` + `ctx.supabase` (throws `UNAUTHENTICATED`).
- `requireRole(...roles)` — adds `ctx.member` (`{ id, merchantAccountId, role }`); throws `FORBIDDEN`.

Server errors flatten to opaque strings (`UNEXPECTED_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`). Import env from `lib/env.ts`, never `process.env` directly.

**`lib/env.ts` validates at module import time (Zod).** Importing *any* export from a file that transitively imports `env` (even a pure, unrelated function) forces validation, which crashes in a test/script environment missing those vars. Keep pure, unit-testable functions in modules that import neither `env`, nor a Supabase client, nor `'use server'`.

### Three-layer transition stack (keep all three in sync on every lifecycle change)

1. `lib/domain/order-state-machine.ts` — legal transitions between `cod_status` values; `canTransition`/`assertTransition`. `LIVREE` is **not terminal** since `0116` (`A_APPELER` via `invalider`).
2. `lib/domain/order-transition-actions.ts` — maps user actions (`confirmer`, `livrer`, `reprogrammer`, `invalider`, …) to 4D dimension patches via `transitionCatalog`; RBAC per action.
3. `lib/actions/transitions.ts` — `performTransitionForContext` orchestrates: role check → load order → `canTransition` → `transition_order` Postgres RPC (atomic: dimensions + stock movements in one tx) → reload → write `audit_log` (service-role, **except `invalider`, see exception below**) → `revalidatePath` → return `{ order, allowedActions }`.

The actual write is in the **`transition_order` Postgres function**, not TS. When changing the lifecycle, update all three TS layers **and** the RPC **and** RLS policies together.

**`cod_status` is trigger-derived** (`derive_legacy_cod_status`, `BEFORE INSERT OR UPDATE`, migration `0023`). Write the four dimensions (`order_state`, `call_state`, `delivery_state`, `cash_state`); the trigger derives `cod_status`. **Never write `cod_status` directly.**

Derivation priority (top→bottom): `delivery_state ∈ {failed,returned}` or `order_state=returned` → `REFUSEE` · `order_state=cancelled` → `ANNULEE` · `delivery_state=delivered` → `LIVREE` · `delivery_state ∈ {out_for_delivery,assigned}` → `EN_LIVRAISON` · `delivery_state=scheduled` → `PROGRAMMEE` · `call_state=validated` → `CONFIRMEE` · `call_state=callback` → `TENTEE` · else → `A_APPELER`.

**Two financially-significant date fields, both editable, both feeding `cash_collected_at` (reporting date of record):**
- `orders.scheduled_for` (since `0096`): for a scheduled-then-delivered order, determines `cash_collected_at` unless overridden.
- `orders.call_confirmed_at` / `p_delivered_at` (since `0114`, both nullable, no backfill): `cash_collected_at = coalesce(p_delivered_at, scheduled_for, now())` — explicit entry beats scheduled date beats click time. `call_confirmed_at` is set whenever `call_state` becomes `validated` (covers both `confirmer`, never shown in the UI, and `programmer`). Lower bound validated in SQL as `least(created_at, created_at_shopify)` (a Shopify order's `created_at` is its import date, not the real order date).
- **All CA/finance surfaces (`/finances`, `/tableau`, report PDF, `finance_kpis`, cohort maturity) are harmonized on `cash_collected_at`** since migration `0119` — never re-introduce a competing date (transition click time, `created_at`) for revenue attribution without deciding this deliberately.

### Two Supabase clients

- `lib/supabase/server.ts` — `createSupabaseServerClient`, cookie-based, **respects RLS** — use in all actions and RSC.
- Service-role admin client — created inline in `transitions.ts`, **bypasses RLS** — only for audit writes. Never use elsewhere.
- `lib/supabase/client.ts` — browser client.

### Roles and agent write scope

Three roles: `owner`, `manager`, `agent`. Capabilities checked in TS (`lib/team/permissions.ts`) AND enforced in Postgres RLS via `current_member_role(merchant_account_id)`. Agents see **all** tenant orders (no row filter); RLS restricts their **write scope** only: `orders_update` `WITH CHECK` limits agent to `cod_status ∈ {TENTEE, CONFIRMEE, PROGRAMMEE, EN_LIVRAISON}`. Because `cod_status` is trigger-derived, the post-trigger row must satisfy that `WITH CHECK`.

### Workspace / multi-boutique

- `getRequestStoreId` never trusts the URL segment; a forged/revoked/foreign `storeId` returns `null`. `getWorkspaceStores` is `React.cache`-memoized per request.
- Legacy URLs (`/produits`, etc.) render **in place** (no redirect) since the redirect+rewrite cycle with `middleware.ts` caused a silent infinite RSC-navigation loop on any account with ≥2 shops. `/s/{storeId}/…` remains canonical; an inaccessible explicit shop 404s.
- **`shop_id` write hygiene**: a write that omits `shop_id` always succeeds (trigger `assign_default_store_context` fills the *default* shop) but lands invisibly if the user is on another shop. Child rows (`order_line`/`call_log`/`delivery_address`/`purchase_lot_line`) must always inherit their **parent's** `shop_id`, never the active shop. `post_stock_movement`/`transition_order`/`reassign_order_driver` derive `shop_id` from their authoritative parent (product / order) since `0131`.
- Column grants do **not** follow columns added later (`0130` had to add explicit `select`/`insert` on `shop_id` for the 7 column-restrictive tables) — grants are evaluated before policies, so a missing grant can't be rescued by RLS.
- `driver` has **no** `shop_id` column — the tenant/shop relationship is N-N via `driver_shop` (a driver can genuinely serve two shops at once; a single FK would have made active orders/movements invisible). Assignment RBAC checks the **order's** `shop_id`, never the request's active shop (`is_driver_in_shop`).
- Post-login: a multi-shop user **chooses** via `/s?next=…` (server redirect, no UI flash); a memberless invitee routes through `resolveMemberlessDestination` toward their pending invitation, never stuck on the "no shop" empty state.
- E2E pitfall: seeding data into a shop that isn't the *active* one renders a silently empty screen — use `defaultShopId` or navigate explicitly to `/s/{id}/…`.

### Analytics pages — Suspense + keyed skeleton (non-negotiable)

Every data-heavy analytics page must: (1) keep top-level `await` minimal; (2) wrap each heavy block in `<Suspense fallback={<AnalyticsSkeleton />}>`; (3) **key the Suspense on the searchParams that change the view** (`key={`${tab}-${period}`}`). A `?tab=` or `?period=` change does NOT trigger `loading.tsx` (same route segment) — without a keyed Suspense the old view freezes. Reference: `app/(app)/finances/page.tsx`.

## Exception délibérée — « Invalider » n'écrit AUCUN `audit_log` ni `order_state_transition`

**Décision produit explicite : l'action `invalider` (`0116`, LIVREE → A_APPELER, owner/manager only) ne pose AUCUNE trace — ni `audit_log`, ni `order_state_transition`.** C'est une exception assumée à la convention systématique du projet. Le geste corrige une erreur de saisie ; le porteur ne veut aucune trace applicative. Verrouillé par des tests qui prouvent l'ABSENCE (`tests/unit/orders/invalidate-audit-exception.test.ts`, `tests/rls/stock-atomicity.rls.test.ts`). Conséquence voulue : invisible dans « Activité récente » du Tableau.

**Ne pas rétablir ces écritures en croyant réparer l'idempotence — elle n'a jamais reposé dessus.** L'anti-rejeu vient de la garde d'état (`select … for update` en tête de `transition_order`, sérialise les appels concurrents ; le second voit `open`/`unassigned` et lève `illegal_invalidation`), pas de la ligne d'historique.

**`stock_movement.transition_id` est une FK vers `order_state_transition(id)` (`0028`)** — l'invalidation utilise `v_movement_transition_id = NULL` sur ce chemin (jamais un `gen_random_uuid()` en mémoire, qui violerait la FK). L'UUID en mémoire ne sert plus qu'à préfixer les clés d'idempotence de l'appel courant.

**Stock : compensation par négation exacte du LEDGER**, jamais par relecture d'`order_line` (sur-restituerait le stock en cas d'`advance_commit` partiel ou de réassignation). Chaque `dispatch` inversé est accompagné d'un `release` apparié pour annuler son effet sur `qty_reserved` — le `reserve` d'origine n'est volontairement PAS contre-passé. Prouvé numériquement (pas déduit) par mutation-test.

**Cas limite cash : invalidation BLOQUÉE si `cash_state ∈ {remitted, discrepancy}`** — `get_driver_cash_consolidation` indexe sur `assigned_driver_id`, que l'invalidation efface ; combiné à l'absence d'audit, le trou financier serait intraçable.

**Audit complet effectué avant de couper l'insert** : les 9 fonctions SQL qui lisent `order_state_transition` filtrent toutes sur un `to_status` précis, jamais sur `A_APPELER` — aucune ne suppose qu'une ligne existe par transition. `getOrderTimeline`/`CallLogForm` sont du code mort (aucun appelant).

## Bugs de reporting résolus (cohérence CA/livraisons) — ne pas régresser

- **`invalider` (`0116`) → `cash_collected_at` repasse à `null`** : CA encaissé, « Livraisons par produit », taux de livraison, rapports mensuels recalculent naturellement sans la commande. Rétroactif et voulu.
- **`0117`** : `/finances` comptait ses livraisons par une requête autonome sur `order_state_transition` (pas de jointure `orders`) — une commande invalidée restait comptée, et livrée→invalidée→re-livrée comptait deux fois. Fix : `finance_kpis.delivered_orders_count`, même CTE que `ca_livre` (`cod_status='LIVREE'` état courant, `group by o.id`). Cohortes de maturité : source réelle est `audit_log` (jamais `order_state_transition`), corrigé côté TS par `deliveredOrderIdSet`.
- **`0119`** : plusieurs rapports CA dataient une livraison par le clic serveur (`order_state_transition.created_at`) au lieu de `cash_collected_at` — désaccord entre écrans sur le même mois. Harmonisé partout (`finance_kpis.ca_livre`/`delivered_orders_count`, `getRevenue30d`, rapport PDF, `deriveCohortMaturityDays`). `get_report_status_breakdown`/`statuses[]` reste volontairement sur `created_at` (fenêtre différente, autre usage — répartition des commandes créées).
- Ce qui reste volontairement historique (courant OU historique, jamais filtré) : `hasRtoEvent`/`hasReturnEvent`, `taux_confirmation` (existence d'une transition CONFIRMEE), `fetchRecentActivityForUser`.

## Critical gotchas

**Postgres / RLS / grants**
- **`DROP`+`CREATE` (signature change) reopens `EXECUTE` to `PUBLIC`; `CREATE OR REPLACE` (identical signature) preserves the existing ACL but NOT security mode/volatility/`search_path`/argument defaults.** Any migration changing a function signature must re-`revoke`/`grant` explicitly, naming every role. `pg_get_functiondef` never shows grants — check `pg_proc.proacl`/`has_function_privilege` directly.
- **`public.transition_order` has 2 dead legacy overloads (4-arg, 5-arg) still executable by `anon`** — `security invoker` so RLS applies (no data leak), but an unswept write door. Cleanup lot pending.
- **`SECURITY DEFINER` role gates must be NULL-safe.** `current_member_role()` returns NULL for non-members; `NULL NOT IN (...)` is not TRUE — always guard as `v_role IS NULL OR v_role NOT IN (...)`.
- **A RPC meant to be called ONLY by the service-role client must be `security invoker` with NO role guard**, `grant execute` restricted to `service_role` — a NULL-safe member guard rejects service-role calls (no `auth.uid()` → role always NULL).
- **`ALTER DEFAULT PRIVILEGES ... REVOKE ... FROM PUBLIC/anon/authenticated` does NOT work on this Supabase stack** (six convergent local reproductions; cause unestablished). Not used as a security control. The proven mechanism is the explicit per-object `revoke` named above (rule #11), enforced by CI (Lot 4A, see below).
- **`RETURNS TABLE(col, ...)` declares those names as PL/pgSQL variables** — an unqualified reference to a homonymous column inside a CTE becomes ambiguous (`get_report_top_products`, `0086`). Always qualify (`items.title`, not `title`).
- **`max_rows=1000` (PostgREST) silently caps any unpaginated `.select()` AND any `RETURNS TABLE`/`SETOF` RPC output**, not just REST. Never aggregate in JS over an unbounded select — aggregate in SQL (`count`/`sum`/`group by`). For RPCs whose row cardinality can exceed ~1000 (e.g. per-movement joins), return `jsonb`/`jsonb_agg` instead of `RETURNS TABLE`.
- **`.in('col', bigUuidArray)` serializes UUIDs into the GET URL** → 400 past the gateway limit on large tenants only (invisible in dev/seed). Fix: a POST-body RPC starting from the merchant+date window, joining server-side.
- **Local "jour métier" boundaries must be computed in TS and passed as `timestamptz`, never reimplemented via `date_trunc` in SQL** (`date_trunc` depends on the Postgres session TZ, ≠ Node's TZ).
- **A guard/plan test must seed *past* the planner's decision threshold** (e.g. 800 rows, not 60) or it measures the fixture size, not production behavior.
- **PostgreSQL flattens nested subqueries — a reused intermediate value gets recomputed per usage.** An `IMMUTABLE` function applied to a `STABLE` argument (`now()`) evaluates per-row, not once. Only a non-correlated scalar subquery `(select f(now()))` survives as a single `InitPlan`.
- **A lock on a projection row must be taken BEFORE aggregating**, not after — otherwise two concurrent writers can both read a stale aggregate under READ COMMITTED (`insert ... on conflict do nothing` does NOT lock the conflicting row).

**Money / domain invariants**
- `cod_status` (text, trigger-derived) is never written directly; total is `total_amount` (numeric). All money is minor-unit bigint (FCFA, 0 decimals) — always via `formatMoney(amount)`, which intentionally ignores `orders.currency`. `cash_collectable_minor` is the cash field.
- `product.unit_cost` is `bigint NOT NULL DEFAULT 0` — never costed = 0, not null. Treat `unit_cost=0 AND frozen COGS=0` as "cost unknown."
- `orders.items_summary` (jsonb) holds line items (Shopify product/variant/sku ids since Phase 3a). `orders.source` distinguishes origin (extended with `'appel'` in `0097`).
- **Logout must always use `signOut({ scope: 'local' })`** — no-scope defaults to `scope: 'global'` and signs out every device. Single call site: `signOutAction`.

**Testing / CI / E2E**
- **`fill()` on an already-filled controlled React input/textarea concatenates instead of replacing** under WebKit — use `click({clickCount:3}) + pressSequentially()` (numeric inputs) or click→`Ctrl/Cmd+a`→`Backspace`→`pressSequentially` (textareas). Dette résiduelle (c): audit any remaining `fill(numeric)` in specs.
- **The service worker (`sw.js`, prod builds / `E2E_PROD_BUILD=1` only) makes page requests INVISIBLE to `page.route()`/`page.on('request')`** once it claims the page (~hundreds of ms after connect). Fix: `test.use({ serviceWorkers: 'block' })` on any `describe` observing network. Never conclude a network-interception test is green/red from a `pnpm dev` run — the SW is absent there.
- **`page.screenshot()` can return an empty image on `/tableau` locally on Windows** even though the DOM/a11y tree is fully rendered; `locator.screenshot()` on a specific element is reliable. Doesn't affect CI (Linux baselines are fine).
- **`toHaveScreenshot` rejects on dimension mismatch BEFORE comparing a single pixel** — `maxDiffPixelRatio` never rescues a non-deterministic *width* (e.g. `min-w-0` missing on a sibling flex/grid item widening the whole row). Always inspect the actual/expected/diff artifacts before regenerating a baseline; a position/reflow diff shows each text line duplicated in red, distinguishing it from a real content change.
- **`*-win32.png` baselines are gitignored** — never probative; only `*-linux.png` (git-tracked) is what CI compares.
- **`update-visual-baselines`'s bot commit does not retrigger `ci.yml`** (GitHub anti-recursion guard on `GITHUB_TOKEN` pushes) — always close/reopen the PR after regenerating baselines.
- **`pnpm typecheck` green locally proves nothing if `node_modules` is desynced from the lockfile** — always `pnpm install --frozen-lockfile` before trusting a long-session local typecheck. Symptom: TS errors pointing at types that "don't exist" in an untouched lib.
- **A CI job stuck far longer than its historical baseline on a normally-fast step (e.g. `playwright install`) is a real infra stall, not a flake to retry blindly** — compare against the last green run's duration first; `gh run rerun <id> --failed` reruns only the failed jobs.
- **A seed that writes order state directly (`admin.from('orders').insert/update`) never populates `order_state_transition`** — only the `transition_order` RPC does. Any view/counter that filters on `order_state_transition.to_status` will silently drop such seeded rows.
- **`ResourceRow` hides its entire `meta` line under 22rem container width** (`@max-[22rem]/row:hidden`) — a container-width threshold, not viewport (iphone-14 390px trips it, pixel-7 412px doesn't). Preexisting responsive debt, not fixed.
- **Mobile table→cards migration: use `sr-only md:not-sr-only md:table`, never `hidden md:table`**, if E2E uses `getByRole` on the table — `display:none` removes cells from the a11y tree.
- **A mobile overflow fix must not change `display`/`flex` on desktop** — use `w-full/sm:w-auto/min-w-0/max-w-full`, not `flex flex-col`, which changes the box model and can collapse a desktop wrap.

**Data-layer patterns**
- **A counter that filters on a field the UI never actually populates is structurally dead** — verify a write path populates it (grep the assignment) before trusting a column-based filter. Principle: counter = exact universe of the target link.
- **Post-mutation server data must never be surfaced via `router.refresh()`/navigation (Paradigm A)** — Router Cache serves stale data ~20-25% of the time in prod builds. Fix: a dedicated read-back server action + inject into client state.
- **Auditing a dormant RPC before reuse means reading ALL its migration history, not just the latest signature** (`list_orders_paginated` never had a period/shop filter across 5 migrations — a superficial read would have missed that the gap is structural).
- **A `Drawer`/`Dialog` (vaul/Radix) mounted directly with `open={true}` (conditional mount) never fires `onOpenChange` on first render** — only a real closed→open transition it observes does. Don't derive init logic from `onOpenChange`; use an effect comparing current `isOpen` against a last-known-value ref.

**Env / build**
- **`upgrade-insecure-requests` in CSP must be prod-only** — WebKit applies it to `http://localhost`, blanking every iphone-14 test.
- **Do not pre-start `pnpm dev` before `pnpm test:e2e`** — Playwright manages the webServer; pre-starting causes `.env.local`/`.env.test` credential mismatches.
- **`E2E_PROD_BUILD=1` builds must be compiled with `.env.test` sourced, never `.env.local`** — `NEXT_PUBLIC_*` are inlined at build time. Symptom otherwise: fresh users failing login with "incorrect credentials" even after a full local reset. `ci.yml` is not exposed (env comes from `$GITHUB_ENV`).

## Dette E2E résiduelle

**(a) Closed.** Build-prod E2E zero-flake proven (3×25 across chromium/pixel-7/iphone-14); `e2e-prod.yml` + warm-up removed post-validation. Don't reintroduce without new documented CI proof.

**(b)/(c) Resolved / ongoing audit.** WebKit `fill()` on controlled spinbuttons doesn't fire `onChange` → fixed via `click({clickCount:3})+pressSequentially()+toHaveValue guard`. Audit any remaining `fill(numeric)` calls when touching E2E specs.

**(d) Resolved (superseded, do not reinstate the old note).** `ci.yml`'s `test-e2e-phase1` job now genuinely exercises signed webhooks — no boutique in this suite sets `shopify_client_id`, so it falls back to the default app (`teer-dev`) whose secret **is** `SHOPIFY_API_SECRET` set on the step. Proven directly: PR #143's 4 deliberate-refusal tests produced exactly 4 `[webhook] async processing failed` per profile, 25 passed each. `test-e2e-regression` does not run `shopify-webhooks.spec.ts` under any of its 4 shards — unproven there either way.

**(e) Open, unresolved, no fix applied.** Intermittent post-login redirect back to `/connexion` in E2E (`auth-multi-device-logout.spec.ts`, `products-bundle-configuration.spec.ts`, and reproduced independently on `orders-hydration-crash-mitigation.spec.ts`/`orders-search-scroll.spec.ts`). Cookie/session instrumentation showed 70/70 clean POST→cookie→checkpoint chains — symptom never captured mid-failure, root cause unknown. Do not modify auth/cookies/timeouts on this hypothesis alone.

**(f) Latent, not urgent.** `drivers.spec.ts:893`'s deterministic 1200ms `page.route` delay can be silently bypassed once the service worker claims the page (prod-build only) — currently green, but the guarantee has a hole. Needs `test.describe` encapsulation to fix (`test.use` scope), deferred to a dedicated E2E-reliability lot alongside the broader `serviceWorkers: 'block'` global-default question.

**(g) Partial.** `ci.yml`'s `timeout 8m` retry loop around `playwright install --with-deps` only gets ONE real attempt per job — a killed `apt-get`/`dpkg` can survive orphaned (outside `timeout`'s process tree) holding the lock, making retries 2/3 fail near-instantly. Fix (`setsid`/`timeout --kill-after`/process-group kill) not yet done.

**(h) Understood, local-only.** `E2E_PROD_BUILD=1` must be built with `.env.test`, not `.env.local` (see gotchas above). Does not affect `ci.yml`.

**(i) Ouvert, dette d'infrastructure CI — pas de sécurité, sans rapport avec S4.** `supabase start` échoue par intermittence en CI sur l'étape « Start Supabase (sanitized diagnostics) », par échec/blocage d'un pull d'image Docker (`ghcr.io`, image `postgres`/`gotrue`/etc. — le log sanitisé n'isole pas laquelle). Confirmé sur **2 occurrences** à ce jour, deux lots distincts : run `33263054883` (`phaseF/lotF2-purchase-lot-profitability`, 2026-08-29, job `test-e2e-phase1`) et run `33791111236` (`phaseSHOP-01/parametres-boutiques-unification`, 2026-09-03, job `test-e2e-phase1 (chromium)`) — corrigé chaque fois par `gh run rerun --failed` sur le seul job concerné, jamais par un changement de code. **Recherche d'une 3ᵉ occurrence non concluante** : le reste de l'historique `ci.yml` accessible (~100 runs) ne montre que des échecs de test réels (assertions, régressions visuelles) sous ce même nom de job, pas ce symptôme précis — si une 3ᵉ occurrence existe, son identifiant reste à fournir. Remède pressenti côté cache d'image ou retry borné sur le pull (ex. `docker pull` avec backoff avant `supabase start`, ou pré-chauffage via `actions/cache` sur les layers), jamais côté code applicatif.

## Gotcha — maturité des cohortes de livraison

`DEFAULT_COHORT_MATURITY_DAYS = 3` (graphe « Taux de livraison dans le temps ») reste cohérent avec l'audit prod (délai moyen 3,37j, médiane 1,88j, p90 10,43j) — pas un SLA. `deriveCohortMaturityDays` utilise la moyenne observée quand un échantillon existe, retombe sur 3 sinon.

## Historique produit condensé (par domaine)

### Commandes / transitions
- **Refuser → Reprogrammer en cours de livraison (`0106`)** : à `EN_LIVRAISON`, « Refuser » est retiré (remplacé par `reprogrammer`, `EN_LIVRAISON→PROGRAMMEE`) ; « Annuler » reste le seul chemin d'abandon. Conséquence assumée : un vrai refus en cours de livraison devient indiscernable d'une annulation pré-dispatch dans `loss-analytics` (RTO non compté). Stock : release ledger-only réutilisé du Lot 2, jamais de retour physique.
- **Orders.note (`0118`)** : note d'équipe libre via RPC `set_order_note` (jamais un update direct — `orders_update` bloquerait l'agent sur `A_APPELER`/`LIVREE`). Distincte de `order_state_transition.note` et de `shopify_order_attributes->>'note'`. 500 chars max (UI + action + base). Contenu jamais dans `audit_log` (seul `{cleared, length}` l'est). `CallLogDialog`/`CallLogForm` (note liée à un appel) sont démontés depuis PR #30, code mort — restaurer ce geste est un sujet séparé.
- **Fix triage recherche `/commandes`** : recherche interactive plafonnée à 12 mois glissants (`sort_at`), annulation réelle via `AbortController` + `GET /api/orders/search` (même `getOrdersPageData`, `.abortSignal`). Pas la solution définitive (RPC de recherche SQL paginée à venir).
- **Crash hydratation #418/#419/#421** : mitigation, pas cause racine confirmée — `prefetch={false}` sur `ResourceRow` (salve de prefetch RSC concurrents par frappe de recherche), capture Sentry enrichie, banner best-effort. `error.tsx` ne peut structurellement jamais rattraper une erreur de *recovery* React (déjà récupérée avant `onRecoverableError`).
- **Suite chronologique des correctifs de perf Tableau/Commandes** (Lots 3-7, QW4) : RPC agrégées SQL remplaçant des `.select()` plafonnés à 1000 lignes (`get_dashboard_cod_breakdown`, `get_dashboard_shop_performance`, `get_dashboard_top_products`, `get_dashboard_priority_counts`, `get_order_view_counts`, `list_orders_keyset`) — chaque fois motivé par le gotcha `max_rows=1000` ci-dessus. `list_orders_paginated` auditée et rejetée (jamais eu de fenêtre période/boutique).

### Invalider (0116/0117) — voir sections dédiées ci-dessus (Exception délibérée, Bugs de reporting résolus).

### Deux dates éditables (0114) — voir Architecture > transition stack ci-dessus.

### Stock / livreurs
- **Ledger-only depuis Lot 4b+4c (`0093`-`0095`)** : `allocate_to_courier`/`courier_return_lot` ne touchent plus `qty_on_hand` (symétrie release/allocate obligatoire). Nouveau movement_type `driver_stock_set` (`0095`) remplace les onglets manuels par une action « Modifier le stock » par ligne sur `/livreurs`, saisie en valeur absolue, delta calculé serveur (`computeDriverStockSetPlan`), deux gardes bloquantes chiffrées.
- **`getDriverAvailableStock`/`getDriverStockOnHand`** lisent `stock_movement` sans pagination — même plafond `max_rows=1000`, dette connue non corrigée au-delà de ~1000 mouvements/livreur. Sont des appelants production actifs (affichage physique+disponible côte à côte).
- **Alerte stock insuffisant (Lot 2 PR3/PR4)** : informative, non bloquante, dans `AssignmentDetailsDialog` (owner/manager) et `TransitionDialog` (agent, `assigner` uniquement).
- **`/livreurs` multi-boutiques (`0133`)** : voir Architecture > Workspace ci-dessus (`driver_shop` N-N).
- **Bundles/packs UI (`/produits` > Détails)** : décochage `is_bundle` autorisé sans blocage même avec commandes en cours référençant le bundle — décision produit assumée (réflexe attendu : annuler + recréer). `product_bundle_component` jamais supprimé au décochage, réapparaît si recoché. 2 appels PostgREST non-atomiques (update produit + composition).

### Finance
- **Lot 5 (`0087`)** : `get_finance_collected_joins`/`get_finance_returned_joins` (`returns jsonb`, pas `RETURNS TABLE` — évite le plafond `max_rows` en sortie). Exception de sécurité délibérée : `security invoker` sans garde de rôle, `grant execute` réservé à `service_role` (ces 3 fichiers appellent déjà via `createFinanceAdminClient()`).
- **CA/livraisons period-aware Tableau (PR C1/#84, `0098`/`0099`)** : `get_dashboard_cash_collected_total`, `get_dashboard_deliveries_by_product`, CA par produit via le pipeline finance existant. Deux cartes CA à ne pas confondre : `ca_collecte` (bande KPI, fenêtre fixe 7j) vs `cashCollected` du bloc Essentiels (fenêtre = PeriodPicker).
- **`toMetricLoadState`** (`lib/dashboard/metric-load-state.ts`) : `ok:false` d'une action financière ne doit JAMAIS devenir `0`/liste vide en UI — pattern `loading/empty/error/ready` + capture Sentry.
- **Règle d'architecture (Lot F2-bis) : Finances liste et agrège, Produits saisit et détaille.** L'onglet `arrivages` de `/finances` (4ᵉ onglet, aux côtés de global/produits/livreurs) affiche la marge par arrivage en lecture seule et renvoie systématiquement vers `/produits?tab=achats&lot={id}` pour tout geste (transport, méthode de répartition, poids, dépense publicitaire) — jamais de champ de saisie sur cet onglet. Cette règle remplace toute lecture antérieure de Finances comme un espace de trésorerie pur : Finances porte déjà plusieurs notions de marge (globale, par produit, désormais par arrivage), toutes en lecture, jamais de saisie.
- **Deux ledgers de dépense publicitaire, jamais réconciliés — double comptage bloqué à la saisie (Lot F2-bis).** `expense` (catégorie système `ADS`, générique, allouée après coup par produit au prorata des ventes de la période — `lib/finance/product-cost.ts`) et `product_ad_spend` (par arrivage, `lib/actions/purchases.ts`) sont deux tables disjointes qu'aucun code ne somme ensemble. La catégorie `ADS` est désormais désactivée à la création d'une dépense dans `ExpenseSection` (reste sélectionnable en édition d'une dépense historique déjà classée ainsi), avec renvoi explicite vers la saisie par arrivage. Non-double-comptage prouvé positivement (deux montants différents sur le même produit/arrivage/fenêtre, chaque lecture ne reflète que sa propre source, mutation-testé) par `tests/rls/lot-f2bis-ad-spend-separation.rls.test.ts`.
- **Transport d'un arrivage corrigeable après création (Lot F2-bis)** : `transport_total` ne se saisissait qu'à la création du lot (`CreateLotForm`), sans champ d'édition ensuite — une marge provisoire sur transport manquant (`transport_total` NULL) ne pouvait donc jamais se compléter. `correctPurchaseLotTransportAction` (owner-only) expose `correct_purchase_lot_cost` (0145, déjà en prod) pour ce seul champ, avant comme après réception ; jamais un `.update()` brut à côté de cette RPC d'audit.
- **Page de démonstration retirée (Lot F2-bis)** : `app/(app)/dev/finance-foundations/page.tsx` supprimée une fois les écrans réels équivalents en place. Gardes reportées sur des écrans réels — détail dans `docs/lexique-microcopie.md`.
- **`correct_purchase_lot_cost` — garde boutique manquante (Lot S1, `0147`)** : la RPC (`0145`, owner-only) confrontait le lot à `merchant_account_id` mais jamais à `shop_id` — un owner multi-boutiques du même tenant pouvait corriger le transport/prix d'achat d'un arrivage d'une boutique à laquelle il n'a plus accès, en contournant la garde applicative (`correctPurchaseLotTransportAction`) par un appel PostgREST direct. Reproduit puis fermé par mesure sur stack local (avant/après `0147`) : ajout de `current_shop_role(v_lot.shop_id) IS DISTINCT FROM 'owner'` (NULL-safe), même rôle `owner` déjà requis par la garde de compte préexistante — aucune régression pour un manager (déjà refusé avant `0147`). `CREATE OR REPLACE` à signature identique : ACL inchangée, vérifiée `pg_proc.proacl`/`has_function_privilege` en local et en production.

### Auth / Workspace
- Milestone 2 (auth redesign), Vague 1 (self-service compte, idle timeout), Vague 3 (Support/Onboarding/FAQ) — mergées, comportement stable, pas de dette active connue au-delà de ce qui est documenté ailleurs.
- **PeriodPicker unifié** (`components/period-picker/`) : Popover ≥md / bottom-sheet Vaul <md, état via nuqs `useQueryStates` (fusionne en place, préserve les autres query params). **`withDefault` efface le param à sa valeur défaut** → conflit avec toute persistence localStorage lisant l'absence de param comme "pas de préférence" ; ne pas l'utiliser pour l'écriture, répliquer le défaut serveur en lecture (`period ?? '30j'`).
- **Radix popover `max-height` en `vh` peut rendre son contenu bas définitivement injoignable** (le contenu réel peut être plus haut que `85vh` sur un petit viewport alors que `scrollHeight===clientHeight` ment). Ne jamais borner par une fraction du viewport ; utiliser `--radix-popover-content-available-height`.

### Clients / scoring fiabilité
- **`customer_reliability_projection` (`0132`)** : matérialise les COMPTEURS invariants, jamais le score (temporel, `power(0.5, âge/180)` évalué à `now()`). Époque d'ancrage `T0=2020-01-01` (`customer_reliability_decay_epoch()`) — ne jamais changer sans rebuild complet. Deux appels RPC séparés divergent légitimement de ~1e-9 (décroissance continue) — parité stricte seulement testable en une seule requête. Tri par risque non indexable par construction (dépend de l'instant de lecture) — fait en tri ensembliste sur la projection.
- **Invalidation par TRIGGERS de niveau instruction sur 5 tables sources** — 23 chemins d'écriture recensés (11 fonctions SQL + 12 sites TS), l'exhaustivité doit être une propriété du schéma, jamais une liste TS. `merchant_member` est une entrée non-évidente (ajout/retrait d'un membre requalifie rétroactivement ses annulations passées).
- **`list_store_customer_reliability` (bug corrigé par `0132`)** : évaluait le score de tous les clients AVANT `LIMIT 50` (fonction dans le `cross join lateral` trié) → 503 sans exception Sentry sur gros compte. `list_customer_reliability` (`0049`) avait le même défaut structurel, préexistant à Phase 1.

## Incident production — 0134/0135 (21 août 2026)

`0134` a révoqué `EXECUTE` sur le cœur `post_stock_movement` (12 args) pour `authenticated`. Or `transition_order` est `SECURITY INVOKER` et appelle ce cœur sous le rôle de l'appelant final → 16 refus `42501` en production, 12min58 (16:34-16:47 UTC). Roll-forward `0135` à 16:50:26 UTC, aucune récidive. **Nombre de marchands touchés indéterminable** (logs sans `shop_id`/user id — dette Sentry ouverte). État résultant : surcharge publique 13-args conservée avec ses gardes ; contournement direct du cœur par `authenticated` rouvert et temporairement accepté (préexistant à 0134) — décision ouverte.

**Règles acquises (clôture Phase 1, `docs/security/phase1-cloture.md`)** — toutes déjà intégrées aux Engineering rules et gotchas ci-dessus (règles #11/#12, section Postgres/RLS/grants). Motif récurrent des défauts de ce chantier : un identifiant reçu du client, jamais confronté au parent autoritatif, transmis à une opération qui dérive le contexte de cet identifiant même — reconnaître ce motif avant d'écrire une nouvelle RPC/read-model scopé tenant/boutique.

**Stage 0 (post-`0136`) confirmé clos** : le cœur 12-args est dans `private` (non exposé PostgREST, `PGRST202` sous `authenticated` **et** `service_role`). Seule surface HTTP : la surcharge publique 13-args, qui applique rôle+allowlist **dans la fonction SQL elle-même** (jamais contournable côté Server Action) : `current_shop_role not in ('owner','manager')` → forbidden ; `p_movement_type` restreint à 4 capacités publiques (jamais `reserve`/`release`/`dispatch`/`sold`/`order_assignment_*`) ; `p_created_by <> auth.uid()` → forbidden. 13/13 tests verts, mutation-testés (`tests/rls/driver-stock.rls.test.ts`).

## Incident cross-tenant `resolveShopDomain` — webhooks Shopify (23 août 2026, PR #143)

`x-shopify-hmac-sha256` ne signe que le corps brut, jamais `x-shopify-shop-domain` (fait Shopify structurel). `resolveShopDomain` préférait ce header non signé au `shop_domain` du corps signé — un secret d'app étant partagé par toutes les boutiques de cette app, un HMAC valide ne prouve QUE « signé par une boutique de cette app », jamais laquelle. **Exploitation** : rejouer un webhook réel avec un header forgé fait piloter le traitement (avec le contenu de l'attaquant) sur le contexte tenant/boutique de la victime.

**Portée** : `shop/redact` le plus grave (écrase toutes les données client d'une boutique, irréversible) ; `customers/redact` réel mais conditionné à une coïncidence d'ID ; `customers/data_request` pollution d'attribution seulement ; `app/uninstalled` le plus facile à déclencher (coupe la sync d'une victime sans qu'elle désinstalle rien). **`orders/*`/`products/*`/`refunds/create`/`bulk_operations/finish` restent HORS SCOPE** — leur corps ne porte structurellement aucune identité boutique signée, rien à confronter au header avec ce mécanisme HTTP. Trois voies structurelles cadrées mais non retenues : URL de callback par installation à secret opaque, livraison Pub/Sub, vérification contre l'API Shopify avec le token de la boutique revendiquée. **C'est précisément ce que le Lot L3 (ci-dessous) commence à livrer.**

**Correctif (`resolveSignedShopDomain`)** : confronte le `shop_domain` du corps signé (autoritatif) au header (garde-fou comparé seulement) sur les 4 topics dont le corps porte l'identité ; divergence/absence → refus avant toute écriture. 4 tests E2E mutation-testés dans `shopify-webhooks.spec.ts` — production run confirme exactement 4 refus attendus par profil.

`shop.shop_gid` reste une colonne morte (jamais peuplée) — second facteur numérique souhaitable, non traité.

## Lot 4A/4B — Détection ACL (Phase 2)

**Le défaut fermé par schéma (`ALTER DEFAULT PRIVILEGES`) est non démontré sur ce stack Supabase — abandonné comme contrôle.** Contrôle retenu : ACL explicite par objet, vérifiée à 4 couches :

1. **Invariant, non régénérable** (`tests/rls/function-execute-acl-invariant.rls.test.ts`) — mesure `has_function_privilege('anon', ..., 'EXECUTE')` en direct (jamais `proacl IS NULL`, qui signifie "défaut ouvert"), liste blanche statique nommée. Fonctions de retour `trigger` exclues (PostgreSQL les rend structurellement non-invocables directement).
2. **Baseline instantané régénérable** (`scripts/generate-acl-baseline.mjs` → `supabase/security/acl-baseline.json`, déterministe octet-pour-octet). `pnpm security:acl-baseline:check` — câblé en CI juste après `pnpm test:rls`. **Ne jamais régénérer pour faire taire un rouge de couche 1** — les deux couches sont indépendantes.
3. **Règle textuelle par migration** (`tests/unit/security/lot4a-migration-revoke-pairing.test.ts`) — seul `CREATE FUNCTION` **plein** (jamais `CREATE OR REPLACE` sur signature identique, dont l'ACL est héritée) doit être suivi d'un `revoke` nommant `anon`. Calibré à 0 faux positif sur 41 migrations réelles. Ne s'applique qu'aux migrations postérieures à `0141`.
4. **Sonde production** (`supabase/security/ci-schema-auditor.sql`, rôle `ci_schema_auditor` : LOGIN only, aucun privilège d'écriture, `SELECT` nommé sur 9 catalogues système) — **APPLIQUÉE, PASS confirmé** (`.github/workflows/acl-production-probe.yml`, quotidien 03:00 UTC). Run réel du 2026-08-24 : production à `0141`, invariant absolu vert, zéro objet en catégorie "dérive non expliquée" (les 3 tables de `0142` classées "retard de déploiement", non bloquant — cohérent, `0142` pas encore poussée). Preuve terme à terme que la classe de dérive de l'incident `0141` (grant manuel jamais committé) serait détectée.

**Dette de couverture assumée** : la sonde ne mesure QUE privilèges table/fonction, jamais colonne (`has_column_privilege`). Critère de réouverture nommé : la première migration qui touche un `GRANT`/`REVOKE` de colonne doit rouvrir cette question.

## Shopify — architecture d'ingestion multi-app (Phase 2, L0→Verrou 0)

**Contexte** : le projet migre progressivement d'un unique endpoint webhook legacy (identité résolue par HMAC + header de domaine) vers une architecture multi-app avec URL opaque par installation, en vue de découpler les abonnements Shopify de la boutique-app-par-défaut et de fermer la dette structurelle documentée dans l'incident cross-tenant ci-dessus.

**Lot L0 (harnais de non-régression, tests uniquement)** : `tests/e2e/shopify-koba-multi-app.spec.ts` généralise la protection `resolveSignedShopDomain` à une app non-par-défaut (teer-koba) et prouve le routage OAuth par `client_id` + l'isolation des secrets entre apps, via mutation-testing sur 3 mécanismes (`getShopifyAppByClientId`, `verifyWebhookHmacAnySecret`, `resolveSignedShopDomain`). Dettes épinglées, non corrigées : repli silencieux sur teer-dev pour un `shopify_client_id` inconnu (L2 l'inversera), `x-shopify-shop-domain` fait autorité sur les topics sans identité signée (L3 l'inversera), state OAuth signé avec le secret par défaut plutôt que celui de l'app sélectionnée (dette L2).

**Schéma canonique L1/L2 (migration `0142`, mergée, non déployée en prod au 2026-08-24)** : `store_connection`, `external_ref`, `ingestion_event` — registre indépendant du chemin d'entrée. Préflight prod avait trouvé 8 lignes `webhook_event` sans contexte boutique, toutes `status in ('done','terminal')` (terminales) : la migration distingue contexte-complet (backfillé) / contexte-absent-et-terminal (exclu, compté, non bloquant) / le reste (bloque, `RAISE EXCEPTION`). **Règle acquise** : les seules sorties `webhook_event.status` réellement définitives sont `'done'`/`'terminal'` (prouvé depuis `finish_shopify_webhook_event`, `0121`) — un prédicat de terminalité s'écrit toujours en allowlist, jamais en blocklist.

**Exception d'édition découverte à cette occasion, formalisée comme règle générale** : une migration commitée mais **absente de la colonne *Remote*** de `supabase migration list --linked` (jamais déployée) peut être corrigée sur place plutôt que suivie d'un correctif `NNNN`+1 — condition à revérifier avant chaque édition, jamais supposée d'une session à l'autre. Dès qu'une migration apparaît en *Remote*, l'exception ne s'applique plus.

**L3 — jeton d'URL opaque par installation (migration `0143`, mergée, non déployée)** : `store_connection_webhook_token` (une ligne par connexion, secret hashé sha256, rotation avec chevauchement 30j max via `previous_secret_hash`). `app/api/shopify/ingest/[token]/route.ts` : ordre d'autorité **URL (jeton) → connexion → app → identification de l'app ayant réellement validé le HMAC (parmi toutes les apps enregistrées) → recoupement app/jeton → comparaison (garde-fou, jamais autoritatif) du header**. 7 causes de refus internes → une seule réponse externe 401 vide. **Périmètre réduit délibérément** : le endpoint écrit dans le registre L1/L2 mais n'appelle PAS encore les fonctions métier legacy (`persistShopifyOrder` etc.) — aucun abonnement Shopify réel ne pointe vers lui dans ce lot ; c'est un lot de mécanisme, pas de bascule de trafic réel.

**Idempotence métier `refunds/create` (migration `0144`, confirmée déployée en prod)** : précondition posée avant la bascule — c'était le seul topic sans filet d'idempotence métier. `store_connection_resource_receipt` (clé `store_connection_id`+`resource_kind`+`external_id`, PAS `delivery_id` — deux livraisons du même remboursement porteront des `delivery_id` différents pendant la bascule). `record_shopify_refund_receipt(...)` : garde + `orders.financial_status` + `audit_log` en une seule transaction PL/pgSQL. Repli explicite sur l'ancien comportement non gardé si la connexion est irrésolvable (jamais de perte silencieuse d'audit).

**Outillage de bascule des abonnements (branche `phase2/lot-l1-l2-migration-tooling`, PR #159/#160)** : `scripts/webhook-subscription-migration.mjs` (`--plan`/`--apply`/`--rotate-token`) et `docs/security/webhook-subscription-bascule-runbook.md` (runbook de fermeture en deux temps). Faits établis pendant la revue : politique de retry Shopify = 8 tentatives sur 4h, backoff exponentiel, adresse de livraison liée **au moment du déclenchement** (jamais redirigée mi-cycle même si l'abonnement change d'URL) ; `app/api/cron/shopify-reconcile` (quotidien 02:00 UTC) couvre réellement les commandes jamais reçues via un bulk pull Admin API filtré sur `updated_at`, indépendant de l'état local — mais **scope `orders/*` uniquement**, aucune couverture `products/*`/`refunds/create`/`bulk_operations/finish`. Bug d'idempotence trouvé et corrigé (pas de rotation implicite de jeton).

**Verrou 0 — parité d'écriture métier sur l'endpoint opaque, LEVÉ (PR #161)** : extraction d'un cœur métier partagé `lib/shopify/webhook-core.ts`, appelé identiquement par les deux endpoints (legacy résout l'identité par header de domaine signé ; opaque résout par jeton→connexion), chacun ne faisant plus que sa propre résolution d'identité avant de déléguer. Parité d'écriture prouvée en HTTP réel sur les 9 topics opérationnels (orders×4, products×2, refunds, app/uninstalled) + idempotence-par-livraison + garde hors-ordre + idempotence de remboursement à deux `delivery_id` distincts sur le chemin opaque — chacune mutation-testée. **Constat clé qui a motivé ce lot** : avant Verrou 0, l'endpoint opaque n'écrivait pas `webhook_event` (seul `ingestion_event`) — cassant silencieusement `scripts/l2-consistency-check.mjs` et la détection d'idempotence/hors-ordre dès qu'un abonnement réel basculerait. Résolu : les deux endpoints écrivent désormais `webhook_event` ET `ingestion_event` de façon identique via `recordWebhookReceipt`. Legacy inchangé au comportement (types d'erreur terminaux préservés via `LegacyShopResolution`).

**`scripts/l2-consistency-check.mjs`** compare `webhook_event` (autoritaire en lecture) à `ingestion_event` par identité de livraison — mesure l'ÉCART entre les deux représentations, **jamais** une attestation d'autorité. Post-Temps-1 réel de la bascule (abonnements réels basculés), une section dédiée du script signale les lignes `ingestion_event` de topics opérationnels sans `webhook_event` correspondant comme NORMALES (pas un écart).

**Reste à faire pour la bascule réelle (Étape 3, hors scope de tous les lots ci-dessus)** : un sous-domaine dédié (`WEBHOOK_PUBLIC_BASE_URL`) est le seul bloqueur restant — responsabilité du porteur, pas du code. Dette connue et documentée dans le runbook, non traitée : `refunds/create` sans clé de dédup portait ce risque avant `0144` (résolu) ; configuration webhook des apps `teer-pilote`/`teer-marchand`/`teer-koba` absente du dépôt (uniquement dans leurs Partner Dashboards respectifs) ; scopes suffisants pour `webhookSubscriptionCreate` raisonnés depuis la doc Shopify, jamais prouvés contre un jeton réel installé.

## Dette Shopify / stock non liée à l'ingestion

- **`mapShopifyVariantToProductInsert`** compare `productNode.status === 'ACTIVE'` (GraphQL, majuscule) contre des valeurs REST minuscules — `is_active` est donc toujours `false` via le webhook path. Pré-existant, hors scope, non corrigé.
- **Depuis `0111`**, une mise à jour Shopify reconstruit `order_line` uniquement si la commande est `unassigned`, `cash_state=not_due`, sans `cart_locally_modified_at` — paniers assignés/encaissables/modifiés localement restent hors resynchronisation.
- **223 commandes avec `items_summary` sans `order_line` détectable** (audit prod, lecture seule, jamais backfillé) — nécessite un chantier stock dédié (résolution produits/bundles, delta par état, mouvements compensatoires idempotents, atomicité commande+lignes+cascade). Ne jamais backfiller sans ce chantier complet.

---
*This file supersedes any implicit understanding. If in doubt between this file and an ad-hoc instruction, ask the developer.*
