# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Tëër is a PWA (Next.js 15 App Router, React 19) for cash-on-delivery (COD) operations of Senegalese Shopify merchants. Backend is Supabase (Postgres + Auth + RLS). Requires Node 22, pnpm, and the Supabase CLI.

## Commands

```bash
pnpm dev          # next dev
pnpm build        # next build
pnpm lint         # biome check . (lint + format check)
pnpm format       # biome format --write .
pnpm typecheck    # tsc --noEmit
pnpm test:unit    # vitest run tests/unit
pnpm test:rls      # vitest run tests/rls (needs a running Supabase, see below)
pnpm test:e2e     # playwright test (auto-starts `pnpm dev` as webServer)
pnpm db:types     # regenerate lib/supabase/database.types.ts from the linked project
```

Run a single unit test: `pnpm vitest run tests/unit/orders/<file>.test.ts` (or `pnpm vitest -t "<test name>"`).
Run a single e2e spec/project: `pnpm exec playwright test tests/e2e/orders-transitions.spec.ts --project=chromium`.

CI (`.github/workflows/ci.yml`) runs lint → typecheck/test-unit/test-rls → test-e2e. `test:rls` spins up a local stack via `supabase start` and reads keys from `supabase status`; locally it needs `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (RLS tests `skipIf` the service role key is absent).

DB setup: `supabase link --project-ref <ref>` → `supabase db push`. Migrations live in `supabase/migrations/` and are applied in order; there is no migration ORM.

## Architecture

**Mutations go through `next-safe-action`, never raw route handlers.** `lib/actions/safe-action.ts` defines the action clients:
- `actionClient` — base, requires `{ actionName, section }` metadata.
- `authActionClient` — adds `ctx.user` + `ctx.supabase` (throws `UNAUTHENTICATED`).
- `requireRole(...roles)` — adds `ctx.member` (`{ id, merchantAccountId, role }`) by looking up `merchant_member`; throws `FORBIDDEN`.

Server errors are flattened to opaque strings (`UNEXPECTED_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`). Each file in `lib/actions/` exposes one domain's server actions (`orders`, `customers`, `finance`, `team`, `shops`, `shopify`, `auth`, …).

**The COD order lifecycle is the core domain.** It is defined in three layers that must stay in sync:
1. `lib/domain/order-state-machine.ts` — the 8 statuses (`A_APPELER`, `TENTEE`, `CONFIRMEE`, `PROGRAMMEE`, `EN_LIVRAISON`, `LIVREE`, `REFUSEE`, `ANNULEE`), the `legalTransitions` graph, and `canTransition`/`assertTransition`. `LIVREE`/`REFUSEE`/`ANNULEE` are terminal.
2. `lib/domain/order-transition-actions.ts` — maps user *actions* (`confirmer`, `livrer`, …) to target statuses via `transitionCatalog`, and encodes which `TeamRole` may perform each action.
3. `lib/actions/transitions.ts` — `performTransitionForContext` orchestrates: role check → load order → `canTransition` guard → call the `transition_order` Postgres RPC → reload → write `audit_log` (via service-role admin client) → `revalidatePath`.

The actual state write happens in the **`transition_order` Postgres function** (migrations `0008`, `0016`, `0020`), not in TS — the TS layer guards and audits, Postgres enforces. When changing the lifecycle, update the TS state machine, the catalog, the RPC, and the RLS policies together.

**Roles and permissions.** Three roles: `owner`, `manager`, `agent` (`lib/team/permissions.ts`). Capabilities are checked in TS (`hasCapability`, `canChangeMemberRole`, …) AND enforced in Postgres RLS. Notably agents have a narrow, status-scoped view of orders — see the role-scoped RLS in `supabase/migrations/0012`. Every tenant table uses RLS keyed on `merchant_account_id` via `current_member_role(...)`; the project rule is **RLS FORCE on all tenant tables**, and `tests/rls/` exists to prove tenant isolation.

**Two Supabase clients.** `lib/supabase/server.ts` (`createSupabaseServerClient`, cookie-based, respects RLS — use this in actions/RSC) vs. the **service-role admin client** created inline in `transitions.ts` (bypasses RLS — only for audit writes and trusted server work). `lib/supabase/client.ts` is the browser client.

**Env is validated with Zod** in `lib/env.ts`: `publicEnv` (NEXT_PUBLIC_*) and `env` (adds server secrets like `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, Shopify keys). Import from here, not `process.env` directly.

**Routing.** `app/(app)/` is the authenticated shell (commandes, clients, produits, finances, tableau, boutiques, parametres); `app/(marketing)/` is public. `app/api/` holds the non-action route handlers: `shopify/` (OAuth install/callback + HMAC-verified webhooks), `rapport/` (PDF generation), `cron/keep-alive`. Shopify integration logic lives in `lib/shopify/` (oauth, webhook-verify, orders/shop sync, token crypto).

**i18n.** Single locale `fr`, no URL prefix (`i18n/request.ts`), via `next-intl`. All UI strings are centralized in `messages/fr.json` and consumed with `useTranslations`/`getTranslations` — do not hardcode UI text. Wolof is planned (cookie-switched). `html lang="fr-SN"`; dates/money formatted for Senegal (FCFA, `Africa/Dakar`) — see `lib/format/`.

## Conventions

- **All UI text is French.** Use `messages/fr.json` keys.
- Biome (not ESLint/Prettier): single quotes, semicolons, trailing commas, 100-col, 2-space. `noExplicitAny` and `noUnusedVariables` are **errors**; `useImportType` is enforced (use `import type`). `console` is a warning.
- Path alias `@/*` → repo root.
- Design constraint: text on the orange brand color must be `#111`.
- `@react-pdf/renderer` is a `serverExternalPackages` entry and the report route bundles fonts from `lib/pdf/fonts/` — keep PDF code server-only.
- Sentry wraps the Next config (`next.config.mjs`) with a `/monitoring` tunnel route; PostHog analytics via `components/analytics-provider`.

## Critical gotchas

- Order status column is `cod_status` (text), not `status`. Order total column is `total_amount` (numeric).
- All money is stored as minor-unit bigint (FCFA, 0 decimals). Never render a raw amount — always pass through `formatMoney(amount, currency)`. The cash field is `cash_collectable_minor` (bigint).
- **Migrations: write the file and stop.** Do not apply it. Ablaye runs `pnpm exec supabase db push` then `pnpm db:types` locally, confirms, then implementation continues.
- Every new RLS `UPDATE` policy must include a `WITH CHECK` clause. New columns start `nullable` until a phase explicitly requires `NOT NULL` — a transition must never be silently rejected by a constraint.
- The client never decides a transition. `performTransition` / `transition_order` RPC validates preconditions and returns `allowed_actions[]`; the UI only renders what the server returns.
- Shopify is the upstream sync channel, not the source of operational truth. Call outcomes, driver assignment, stock ownership, cash remittance, cancel reasons, and landed cost all live in Tëër.
