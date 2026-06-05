# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) **and Codex CLI** when working with code in this repository. It is the **shared source of truth** for both agents — the solo developer alternates between them depending on token budget, so this file guarantees one agent resumes exactly where the other left off. **Read it fully before changing anything. Update the "Phase tracker" section at the end of every phase.**

> `AGENTS.md` mirrors this file (symlink or one-line pointer). If they ever diverge, this file wins.

## Project

Tëër (Wolof: "to receive / welcome") is a **mobile-first, French-only PWA** (Next.js 15 App Router, React 19) for **cash-on-delivery (COD) operations** of Senegalese Shopify merchants. It is a **COD operations cockpit, not an ERP and not a Shopify clone**. Backend is Supabase (Postgres + Auth + RLS). Requires Node 22, pnpm, and the Supabase CLI. In production at `teer-dev.vercel.app`.

**The pain point:** Shopify wasn't designed for African commerce. Merchants fall back to Excel for stock, driver cash, cancellations, and margin. Shopify doesn't track the COD operational cycle (confirmation calls, attempts, driver assignment, cash remittance, returns). Tëër owns that loop: call → confirm → schedule → assign to a driver → deliver → collect cash → reconcile the till → track stock and real margin — all in one place.

**Market:** Senegalese Shopify merchants who also sell via WhatsApp/TikTok/Facebook; cash delivery; **successful-delivery rate ~25-30%** (high cancellation/refusal — structural, and it drives several design decisions, see "Locked decisions"). Persona: importer-reseller, 5-50 orders/day with peaks at 120 (Tabaski, Black Friday), 2 part-time tele-operators + moto drivers.

**The moat:** the full COD operational loop — Shopify OAuth multi-shop + call workflow + COD state machine + driver cash reconciliation + per-customer/per-product reliability + stock & landed cost for import-resale. No Francophone West African competitor combines all of it. Competitors own the storefront (YouCan, Storeino, EasyAfrik), the trucks (Logidoo, Paps), or the ledger (STOCKALIO) — Tëër owns the operational loop.

## Commands

```bash
pnpm dev          # next dev
pnpm build        # next build
pnpm lint         # biome check . (lint + format check)
pnpm format       # biome format --write .
pnpm typecheck    # tsc --noEmit
pnpm test:unit    # vitest run tests/unit
pnpm test:rls     # vitest run tests/rls (needs a running Supabase, see below)
pnpm test:e2e     # playwright test (auto-starts `pnpm dev` as webServer)
pnpm db:types     # regenerate lib/supabase/database.types.ts from the linked project
```

Run a single unit test: `pnpm vitest run tests/unit/orders/<file>.test.ts` (or `pnpm vitest -t "<test name>"`).
Run a single e2e spec/project: `pnpm exec playwright test tests/e2e/orders-transitions.spec.ts --project=chromium`.

CI (`.github/workflows/ci.yml`) runs lint → typecheck/test-unit/test-rls → test-e2e. `test:rls` spins up a local stack via `supabase start` and reads keys from `supabase status`; locally it needs `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (loaded via `.env.test`; RLS tests `skipIf` the service role key is absent). **Ports 54321-54324 are shared with another local project — stop it before starting Tëër's stack.**

DB setup: `supabase link --project-ref <ref>` → `supabase db push`. Migrations live in `supabase/migrations/` and are applied in order; there is no migration ORM. **Latest migration applied in prod: `0033`. `0034` is written + applied locally but NOT yet pushed to prod (run `pnpm exec supabase db push` then `pnpm db:types`).**

## Engineering rules (non-negotiable)

1. **Invent NOTHING.** No table, column, function, action, route, or component that doesn't exist exactly in the repo. If a referenced name is missing → **STOP** and flag it. (This guardrail already prevented building the stock module on a `product` table that didn't exist yet.)
2. **Migration → STOP.** Write the `.sql` file and stop. The developer runs `pnpm exec supabase db push` then `pnpm db:types` locally, confirms, then implementation continues. You never run `db push` yourself.
3. **Schema deploys to prod BEFORE code.** No TS line references a table/column until its migration is confirmed applied in prod. (Pushing code before schema caused a production error screen in Phase 2.)
4. **One commit per deliverable**, French message prefixed by phase (e.g. `phase3:`). No opportunistic refactors bundled in.
5. **Sanity loop before every code commit:** `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm build`, plus `pnpm test:rls` **non-skipped** (RLS tests prove tenant isolation; never ignored). Never commit red.
6. **`performTransition` is the ONLY write gate for order state.** No applicative `.from('orders').update(...)` on state. The client never decides a transition; it only renders the `allowedActions` the server returns.
7. **Stock is a SIDE EFFECT, never a precondition.** An order line that can't be resolved to a product never fails a transition — skip the stock movement for that line.
8. **Schema/RBAC discipline:** RLS FORCE + deny-by-default; separate policies per operation; every `UPDATE` policy has `WITH CHECK`; new columns start nullable until a phase explicitly requires `NOT NULL` (a transition must never be silently rejected by a constraint). `unit_cost`/margin are hidden from `agent` at the column level.
9. **Never switch agents on a dirty tree.** Commit + push before changing agent; `git status` must be empty (otherwise the other agent doesn't see in-progress work and may overwrite it).

## Architecture

**Mutations go through `next-safe-action`, never raw route handlers.** `lib/actions/safe-action.ts` defines the action clients:
- `actionClient` — base, requires `{ actionName, section }` metadata.
- `authActionClient` — adds `ctx.user` + `ctx.supabase` (throws `UNAUTHENTICATED`).
- `requireRole(...roles)` — adds `ctx.member` (`{ id, merchantAccountId, role }`) by looking up `merchant_member`; throws `FORBIDDEN`.

Server errors are flattened to opaque strings (`UNEXPECTED_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`). Each file in `lib/actions/` exposes one domain's server actions (`orders`, `customers`, `finance`, `team`, `shops`, `shopify`, `products`, `auth`, …).

**The COD order lifecycle is the core domain — now a four-dimension model.** Since migration `0021`, an order is NOT a single status. It has **four orthogonal dimensions** stored in separate columns on `orders`:

| Dimension | Column | Values |
|---|---|---|
| Lifecycle | `order_state` | `open · completed · cancelled · returned` |
| Calls | `call_state` | `to_call · callback · validated · unreachable` |
| Delivery | `delivery_state` | `unassigned · scheduled · assigned · out_for_delivery · delivered · failed · returned` |
| Cash | `cash_state` | `not_due · expected · collected · remitted · discrepancy` |

Support columns: `attempt_count`, `next_contact_at`, `scheduled_for`, `cancel_reason`, `assigned_driver_id`.

**`cod_status` (legacy 8 values: `A_APPELER · TENTEE · CONFIRMEE · PROGRAMMEE · EN_LIVRAISON · LIVREE · REFUSEE · ANNULEE`) is NOT the source of truth and NOT a generated column.** It is a real column kept in sync by a **`BEFORE INSERT OR UPDATE` dual-write trigger** (`derive_legacy_cod_status`, migration `0023`, `SECURITY DEFINER`). You write the **four dimensions**; the trigger derives and writes `cod_status` in the same operation. **Never write `cod_status` directly.** Derivation priority (top→bottom): `delivery_state ∈ {failed,returned}` or `order_state=returned` → `REFUSEE` · `order_state=cancelled` → `ANNULEE` · `delivery_state=delivered` → `LIVREE` · `delivery_state ∈ {out_for_delivery,assigned}` → `EN_LIVRAISON` · `delivery_state=scheduled` → `PROGRAMMEE` · `call_state=validated` → `CONFIRMEE` · `call_state=callback` → `TENTEE` · else → `A_APPELER`. `cod_status` is not yet dropped (transition window); `reconcile_order_cod_status()` (`0024`) proves zero drift dimensions↔legacy.

The lifecycle is defined in layers that must stay in sync:
1. `lib/domain/order-state-machine.ts` — legal transitions, `canTransition`/`assertTransition`.
2. `lib/domain/order-transition-actions.ts` — maps user *actions* (`confirmer`, `livrer`, …) to dimension changes via `transitionCatalog`, and which `TeamRole` may perform each action.
3. `lib/actions/transitions.ts` — `performTransitionForContext` orchestrates: role check → load order → `canTransition` guard → call the `transition_order` Postgres RPC (which writes the dimensions atomically, the trigger derives `cod_status`, **and posts stock movements via `post_stock_movement` in the same transaction** — all or nothing) → reload → write `audit_log` (service-role admin client) → `revalidatePath`, returning `{ order, allowedActions }`.

The actual state write happens in the **`transition_order` Postgres function** (migrations `0008`, `0016`, `0020`, extended in Phase 1 to write dimensions), not in TS — the TS layer guards and audits, Postgres enforces. When changing the lifecycle, update the TS state machine, the catalog, the RPC, and the RLS policies together.

**Roles and permissions.** Three roles: `owner`, `manager`, `agent` (`lib/team/permissions.ts`). Capabilities are checked in TS (`hasCapability`, `canChangeMemberRole`, …) AND enforced in Postgres RLS, keyed on `merchant_account_id` via `current_member_role(...)`; **RLS FORCE on all tenant tables**, and `tests/rls/` proves tenant isolation.

> **Corrected (was stale):** agents are **no longer** given a status-scoped row view. Migration `0020` (Phase 0) **removed the status filter from `orders_select`** — it was the cause of a white-screen bug (a confirmed order disappeared from the agent's view mid-workflow). The agent now **sees all of the tenant's orders**; the per-view filtering is **application-level** (saved views), not RLS. What RLS still restricts is the agent's **write scope**: `orders_update`'s `WITH CHECK` limits an `agent` to producing `cod_status ∈ {TENTEE, CONFIRMEE, PROGRAMMEE, EN_LIVRAISON}` (owner/manager: all). Because `cod_status` is trigger-derived, the post-trigger row must satisfy that `WITH CHECK` — verified by `tests/rls/orders-dimensions.rls.test.ts`.

**Two Supabase clients.** `lib/supabase/server.ts` (`createSupabaseServerClient`, cookie-based, respects RLS — use this in actions/RSC) vs. the **service-role admin client** created inline in `transitions.ts` (bypasses RLS — only for audit writes and trusted server work). `lib/supabase/client.ts` is the browser client.

**Env is validated with Zod** in `lib/env.ts`: `publicEnv` (NEXT_PUBLIC_*) and `env` (adds server secrets like `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, Shopify keys). Import from here, not `process.env` directly.

**Routing.** `app/(app)/` is the authenticated shell (commandes, clients, produits, finances, tableau, boutiques, parametres); `app/(marketing)/` is public. `app/api/` holds non-action route handlers: `shopify/` (OAuth install/callback + HMAC-verified webhooks), `rapport/` (PDF generation), `cron/keep-alive`. Shopify integration lives in `lib/shopify/` (oauth, webhook-verify, orders/shop/product sync, token crypto).

**i18n.** Single locale `fr`, no URL prefix (`i18n/request.ts`), via `next-intl`. All UI strings centralized in `messages/fr.json`, consumed with `useTranslations`/`getTranslations` — **do not hardcode UI text**. Wolof planned (cookie-switched). `html lang="fr-SN"`; dates/money formatted for Senegal (FCFA, `Africa/Dakar`) — see `lib/format/`. Phone normalization in `lib/address/phone-sn.ts` (`normalizeSenegalPhone`).

## Data model — canonical entities (exact names)

Tenant tables (all carry `merchant_account_id`, RLS FORCE): `merchant_account` · `merchant_member` (role `owner|manager|agent`) · `shop` · `webhook_event` · `customer` · `product` (catalogue, Phase 3a/`0027`) · `orders` · `order_state_transition` · `order_line` (Phase 3b/`0028`) · `call_log` · `audit_log` (extended: `prior_state, next_state, source, reason`) · `invitation` · `driver` (non-auth) · `cash_settlement` · `settlement_allocation` · `settlement_shortfall` · `merchant_settings` · `stock_movement` (append-only, Phase 3b/`0028`) · `product_stock` (denormalized projection, Phase 3b/`0028`).

Key functions/RPC: `transition_order` (writes dimensions + derives `cod_status` via trigger + posts stock movements atomically via `post_stock_movement`) · `derive_legacy_cod_status` (trigger) · `current_member_role(merchant_account_id)` (SECURITY DEFINER) · `post_stock_movement(...)` (SECURITY DEFINER — ledger insert + `FOR UPDATE` + position update in one transaction) · `reconcile_order_cod_status()` · `reconcile_product_stock()` · `rebuild_product_stock()`.

## Locked decisions (do not re-litigate without explicit reason)

- **Stock — decrement at DISPATCH, not at validation.** The reserve at validation is **soft and non-blocking** (`qty_reserved`; never touches `qty_on_hand`; never blocks a new order). The **only** hard `qty_on_hand` decrement is at dispatch (assign/out_for_delivery). *Reason: ~25-30% delivery rate → hard-reserving at validation would create massive phantom reservations.*
- **RTO/return:** after dispatch the stock is physically with the courier. Cancel/fail does **not** auto-restore stock — it returns via a separate `courier_return` movement posted at physical return.
- **Stock = append-only `stock_movement` ledger + denormalized `product_stock` projection**, maintained in the same transaction (`SELECT … FOR UPDATE` + `idempotency_key`). No trigger as the primary mechanism (the engine is the sole gate). `stock_movement` is immutable: no `UPDATE`/`DELETE` policy; corrections are compensating movements. `manual_adjustment` requires a mandatory reason.
- **Cost:** moving weighted-average (CUMP), recomputed on `purchase_in`, **snapshotted** onto every outbound movement (COGS frozen at the cost in force when goods leave). SYSCOHADA/OHADA-compliant (AUDCIF Art. 44: PEPS or CMP; LIFO forbidden). *Validate the account mapping (601/6031/31) and CUMP timing with a Senegalese OHADA accountant before any tax use.*
- **Orders:** one canonical list + 8 saved views (filters, no Kanban): **Toutes · À appeler · Tentée/À rappeler · Confirmée · À livrer aujourd'hui · Cash à remettre · Annulées · Retours**. Inline status change via the engine. Manual creation uses a **product selector** (no free-text title). Search by name/phone/product.
- **Phasing:** driver stock (`driver_stock`) = Phase 4, not before. Real `unit_cost` from purchase lots = Phase 5; manual until then. Margin = Phase 6. AI assistant = Phase 8 (read-only, function-calling, never free SQL).
- **Shopify is the upstream channel, never the operational source of truth.** Call outcomes, driver assignment, stock ownership, cash remittance, cancel reasons, landed cost all live in Tëër.

## Conventions

- **All UI text is French.** Use `messages/fr.json` keys.
- Biome (not ESLint/Prettier): single quotes, semicolons, trailing commas, 100-col, 2-space. `noExplicitAny` and `noUnusedVariables` are **errors**; `useImportType` enforced (use `import type`). `console` is a warning.
- Path alias `@/*` → repo root.
- Design constraint: text/icon on the orange brand color is **always `#111`, never white**. Touch targets ≥ 44px on COD actions. Numbers in Geist Mono tabular-nums.
- `@react-pdf/renderer` is a `serverExternalPackages` entry; the report route bundles fonts from `lib/pdf/fonts/` — keep PDF code server-only.
- Sentry wraps the Next config (`next.config.mjs`) with a `/monitoring` tunnel route; PostHog analytics via `components/analytics-provider`.

## Critical gotchas

- Order status legacy column is `cod_status` (text), trigger-derived, **never written directly** — see Architecture. Order total column is `total_amount` (numeric).
- All money is stored as minor-unit bigint (FCFA, 0 decimals). Never render a raw amount — always pass through `formatMoney(amount)`. The cash field is `cash_collectable_minor` (bigint).
- **Devise : FCFA exclusivement à l'affichage (mono-devise ; multi-devise différé).** `formatMoney` **ignore volontairement** la devise stockée (`orders.currency`) et affiche toujours « F CFA » arrondi à l'entier. La colonne `orders.currency` est conservée pour un éventuel multi-devise futur (marché hors zone CFA) mais ne pilote plus l'affichage. Ne pas réintroduire de lecture de devise « au hasard » (l'ancien `limit(1)` côté Clients a été retiré).
- **Migrations: write the file and stop. Schema to prod before code.** (See Engineering rules 2 & 3.)
- Every new RLS `UPDATE` policy includes a `WITH CHECK`. New columns start nullable.
- The client never decides a transition. `performTransition`/`transition_order` validate preconditions and return `allowedActions`; the UI only renders what the server returns.
- `orders.items_summary` (jsonb) holds line items; since Phase 3a it also captures Shopify `product/variant/sku` ids per line (older orders have free-text titles only → resolved best-effort). `orders.source` distinguishes origin.

## Phase tracker (update at the end of every phase)

| Phase | Scope | Migrations | Status |
|---|---|---|---|
| **0** | Server transition engine + confirm/schedule bug fix + critical-path E2E | 0020 | ✅ Done |
| **1** | 4-dimension model + backfill + dual-write trigger + extended audit log | 0021–0024 | ✅ Done (zero reconciliation drift, RLS green) |
| **2** | Unified list + 8 saved views + inline status + manual creation + search + remove "Frais & taxes" | 0025–0026 | ✅ Done |
| **3a** | Product catalogue (`product` table, `read_products` scope, capture Shopify line ids, product selector) | 0027 | ✅ Done (catalogue populated in prod) |
| **3b** | Stock module: `stock_movement` + `product_stock` + `order_line` + `post_stock_movement` (atomic) + movements in `transition_order` + CUMP + thresholds + manual adjustment + courier_return + Stock page + reconciliation filet | 0028–0030 | ✅ Done |
| **4** | Drivers: `stock_movement.driver_id` + `allocate_to_courier`/`courier_return_lot` (stock en main **dérivé du ledger**, lot + per-order) + cash consolidation (reuses cash tables) + performance + Livreurs tab | 0031 | ✅ Done (RLS green incl. invariant, E2E green) |
| **5** | Purchases: supplier lots + business-day ETA + landed cost → CUMP | 0033–0034 | 🔄 Code + RLS green (36/36). **Reste : push `0034` en prod ; run E2E `tests/e2e/purchases.spec.ts` (bloqué localement par port 3000 occupé) ; retirer le cast `GenericRpc` de `receiveLotAction` après `db:types`.** |
| **6** | Finance: returns-aware revenue + COGS + expenses + net profit + 0.5% default | — | ⬜ |
| **7** | Shopify sync hardening + customer enrichment + cancellation/return analytics | — | ⬜ |
| **8** | AI assistant (metrics function-calling, read-only, RLS-scoped) | — | ⬜ |

**Transition → movement mapping (authoritative SQL, `0029`):** call→validated (delivery=unassigned) → `reserve` (+qty_reserved, soft) · delivery→assigned/out_for_delivery → `dispatch` (−qty_on_hand, −qty_reserved, CUMP snapshot) · delivery→delivered → `sold` (COGS snapshot) · cancel/refuse when delivery∈{unassigned,scheduled} → `release` (−qty_reserved) · cancel/refuse/fail when delivery∈{assigned,out_for_delivery} → **no movement** (stock with courier; `courier_return` posted manually at physical return).

**Stock atomicity:** `transition_order` (0029) calls `post_stock_movement` per resolved `order_line` **within its own transaction**. An exception in `post_stock_movement` rolls back the entire transition. Unresolved lines (match_status ≠ 'matched') are silently skipped. Autonomous stock actions (`purchaseInAction`, `manualAdjustmentAction`, `courierReturnAction`) call `post_stock_movement` via `supabase.rpc()` — single atomic HTTP call. Nightly pg_cron (`0030`) runs `reconcile_product_stock()` and persists discrepancies in `stock_reconciliation_alert`; `rebuild_product_stock()` reconstructs from the ledger on demand.

**Driver stock (Phase 4, `0031`):** `stock_movement.driver_id` (nullable) attributes a movement to a `driver`. `post_stock_movement` accepts `p_driver_id` and two lot movement types: `allocate_to_courier` (advance lot leaving the warehouse to a courier, `−qty_on_hand`, CUMP snapshot, no order) and `courier_return_lot` (unsold lot back, `+qty_on_hand`); both require a driver (CHECK). `transition_order` now passes the order's effective driver to every per-order movement. **Driver stock-in-hand is DERIVED from the ledger** (`lib/drivers/stock-on-hand.ts`: `Σ −qty` over `dispatch/allocate_to_courier/sold/courier_return/courier_return_lot` for the driver) — never a separate source of truth; invariant `Σ driver-in-hand + warehouse = ledger` holds. Cash per driver **reuses** `cash_settlement`/`settlement_allocation`/`settlement_shortfall` (`record_cash_settlement` global remittance) — `lib/drivers/cash-consolidation.ts` derives dû/collecté/remis/écart. Livreurs tab (`/livreurs`, owner/manager) shows stock-in-hand, cash, performance per driver. Autonomous lot actions: `allocateToCourierAction`, `courierReturnLotAction`.

**Purchases / landed cost (Phase 5, `0033`–`0034`):** a supplier shipment is a `purchase_lot` (header: supplier, ref, `ordered_at`, `shipping_mode`, `supplier_prep_days/transport_days/local_buffer_days`, `eta_override`, four shared-fee columns `freight/customs/transit/local_transport_total`, `allocation_method`, `status ordered→in_transit→received`) + `purchase_lot_line` rows (`product_id`, `qty`, `unit_purchase_price`, and receipt-derived `line_value/allocated_fees/landed_total_value/landed_unit_cost`, nullable until received). **Shared fees are spread across lines by the largest-remainder method, weighted by line value, in pure bigint** (`lib/purchases/fee-allocation.ts`: `Σ allocated = Σ fees` exactly; V=0 → equal split). **ETA = business days** skipping weekends (`lib/purchases/eta.ts`: `addBusinessDays`/`computeEta`; `eta_override` wins; Senegalese holidays handled via the manual override). **Receipt is atomic**: `receive_purchase_lot(p_lot_id, p_merchant_account_id, p_actor_id, p_lines jsonb)` (`0034`, SECURITY DEFINER) locks the lot, writes the derived columns per line, and posts one `purchase_in` per line via `post_stock_movement` **passing `p_received_value = landed_total_value`** so the CUMP numerator uses the exact landed total (no rounding drift from `qty × floor(landed/qty)`) — all in one Postgres transaction. `post_stock_movement` gained `p_received_value bigint default null` in `0033` (backward-compatible; **only the `purchase_in` branch changed** — every other movement type is byte-for-byte the 0031 body). **Owner-only**: `purchase_lot`/`purchase_lot_line` RLS FORCE restricts SELECT/INSERT/UPDATE to `current_member_role = 'owner'`; manager/agent see zero rows and cannot write (proven in `tests/rls/purchases.rls.test.ts`). Actions in `lib/actions/purchases.ts` (`createPurchaseLotAction`, `updatePurchaseLotAction`, `add/removePurchaseLotLineAction`, `markLotInTransitAction`, `receiveLotAction`, `getPurchaseLotPageData`) all use `requireRole('owner')`. UI: owner-only "Achats fournisseur" section on `/produits` (`components/purchases/purchase-lots-view.tsx`) shows the per-line landed-cost breakdown + a `Σ frais alloués = Total frais` reconciliation line; `merchant_settings.import_vat_recoverable` (bool, default true) is reserved for Phase 6 VAT handling.

## Agent alternation workflow (Codex CLI ↔ Claude Code)

- On session start: read this file, then the **current phase prompt** (provided by the developer) which carries the precise task. This file = durable context; the phase prompt = the task.
- Commit + push before switching agents (`git status` empty).
- At end of phase: update the Phase tracker (status + migrations + remaining) in the **same final commit**.

---
*This file supersedes any implicit understanding. If in doubt between this file and an ad-hoc instruction, ask the developer.*