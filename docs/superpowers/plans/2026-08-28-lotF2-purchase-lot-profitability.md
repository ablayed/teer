# Lot F2 — Rentabilité par arrivage (saisie minimale + consultation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the F2 screens (saisie minimale : transport, méthode de répartition, poids facultatif, dépense publicitaire ; consultation : liste des arrivages + fiche arrivage) inside the existing `/produits?tab=achats` tab, backed by one new read-only aggregation RPC and the existing pure `lib/finance/lot-profitability.ts` engine, plus a durable offline mutation queue for the three new writes.

**Architecture:** A single new SQL RPC (`get_purchase_lot_profitability`) does *only* joins/sums (FIFO ledger qty, cash imputed by quantity-share of `orders.total_amount`, ad spend sums, presence/absence of transport) and returns raw per-line `jsonb`. All margin/％/répartition/complétude math stays in the existing pure TS engine (`lib/finance/lot-profitability.ts`) — never duplicated in SQL. Three new `requireRole('owner')` server actions extend `lib/actions/purchases.ts`. A new generic IndexedDB-backed mutation queue (`lib/offline/mutation-queue.ts`) sits between the three new client forms and their server actions, giving durable-draft + idempotent-retry behavior. UI additions live entirely inside `components/purchases/` and are surfaced from the existing `PurchaseLotsView` — no new route, no new nav destination.

**Tech Stack:** Next.js App Router / Server Actions via `next-safe-action`, Supabase (Postgres + PostgREST + RLS), Vitest (unit + RLS), Playwright (E2E), raw browser `indexedDB` (no new dependency).

## Global Constraints

- **Migration scope, exactly:** one additive migration containing **only** the aggregation RPC (`get_purchase_lot_profitability`) and its ACL (revoke/grant). No other schema change. Write the `.sql` file, then **STOP before `db push`** (project rule #2). Migration and the code that depends on it (assembly layer + actions) share **one commit**, per this project's general batch-workflow rule — the developer explicitly chose this over the F2 correction message's "separate commits" note when the two were flagged as conflicting.
- **No margin/％/allocation formula in SQL.** The RPC only aggregates (sums, joins, presence checks). `lib/finance/lot-profitability.ts` is reused verbatim — not reimplemented, not forked.
- **No new financial *display* component.** Reuse `Amount`, `ValueAmount`, `GainLoss`, `ScopedMetricCard`, `ExplanationCard`, `ListCard`, `EmptyState`, `InsufficientDataState` from `components/ui/*` exactly as built in Lot U1-F. A plain numeric *input* (not a display component) is allowed and scoped locally to this lot's files.
- **No new navigation destination.** Everything surfaces from `/produits?tab=achats` (already owner-gated) via a `DetailPanel`, never a new route.
- **Finances untouched.** No file under `app/(app)/finances/**`, `components/finance/**`, `lib/finance/finance-joins.ts`, `lib/finance/product-cost.ts`, `lib/finance/report-data.ts` may change.
- **Vouvoiement, no exceptions** (`docs/lexique-microcopie.md`). Vocabulary: « coût de revient rendu », « marge », « invendu », « CA encaissé », « publicité », « arrivage ». Forbidden: « réconciliation », « COGS », « marge de contribution », any « coût de reprise / retour / refus » notion.
- **Owner-only for ad spend**, at both UI and server-action layers (`requireRole('owner')`), mirroring `product_ad_spend`'s RLS.
- **Every new Server Action confronts every client-supplied id to its authoritative parent** (merchant_account_id/shop_id) before use — same discipline as the rest of `lib/actions/purchases.ts`.
- **Amounts:** integer minor units (FCFA, 0 decimals), formatted only via `formatMoney`/`Amount`. Never a float on a money field.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/0146_lotF2_purchase_lot_profitability_rpc.sql` | New | The one allowed RPC + ACL. |
| `lib/finance/lot-profitability-assembly.ts` | New | Turns the RPC's raw jsonb into a full report by calling the existing pure engine per line, then aggregates lot totals. Pure, unit-testable, no `env`/Supabase import. |
| `lib/actions/purchases.ts` | Modified | Add `getPurchaseLotProfitability`, `setPurchaseLotAllocationMethodAction`, `setPurchaseLotLineWeightAction`, `createProductAdSpendAction`. |
| `lib/offline/mutation-queue.ts` | New | Generic durable IndexedDB mutation queue (enqueue, flush-on-reconnect, idempotent, event-based settle notifications). |
| `components/purchases/purchase-lot-detail-panel.tsx` | New | "Fiche arrivage" — `DetailPanel` with margin-first ordering, method/weight editing, ad-spend entry trigger. |
| `components/purchases/product-ad-spend-form.tsx` | New | The 4-field ad-spend form, reusable from the fiche and from the product detail panel. |
| `components/purchases/purchase-lots-view.tsx` | Modified | `LotCard` gains margin/marge%/avancement + a "Voir la rentabilité" trigger opening the new detail panel. |
| `components/products/product-detail-panel.tsx` | Modified | Owner-only "Ajouter une dépense publicitaire" entry point, resolves/asks for the lot. |
| `tests/unit/finance/lot-profitability-assembly.test.ts` | New | Reference control (89 360 F / 21,9 %), missing-transport → provisional, missing-derived-value masking, method availability. |
| `tests/unit/offline/mutation-queue.test.ts` | New | Enqueue/flush/idempotent-retry/settle-event, fake IndexedDB. |
| `tests/rls/lot-f2-purchase-lot-profitability.rls.test.ts` | New | RPC positive read, cross-shop/cross-tenant refusal, anon refusal, reference control via the RPC itself, ad-spend RBAC + tenant-scoping mutation tests. |
| `tests/e2e/lot-f2-purchase-lot-detail.spec.ts` | New | 412px/390px no-truncation, offline queue proof (real network via `context.setOffline`), ad-spend-requires-lot mutation test. |

---

### Design decisions carried into the tasks below (stated once here, not re-litigated per task)

1. **CA encaissé imputé per lot line** = for each net allocation row (`purchase_lot_line_allocation`, already signed sale/return/invalidation), the order's `total_amount` split **by quantity share** across that order's matched product lines (`qty / Σqty of matched lines in that order`), summed per `purchase_lot_line_id`. This mirrors the existing equal-per-unit allocation technique already used for delivery-fee splitting in `lib/finance/product-cost.ts` (`allocateByWeights`) — it does not re-derive the fuzzy `items_summary` title-matching pipeline that lives in Finances (out of scope, and would duplicate business logic in two places). `total_amount` is already net of delivery fee (see `lib/finance/lot-profitability.ts` docstring), matching the engine's expectation.
2. **Ad-spend completeness**: `product_ad_spend` has no "confirmed zero" flag; an empty sum for a product is a legitimate zero (unlike `unit_cost`, there is no default-zero schema trap here — rows only exist when a human entered one). The RPC/assembly therefore always report ad spend as `complete: true` (amount 0 when no rows exist). Only `transport_total IS NULL` drives `transportComplete: false` (this exact case is already the U1-F demo's missing-row example).
3. **Weight cleared after 'weight' method already selected**: the assembly layer calls `isAllocationMethodAvailable` before calling `computeLotProductProfitability`. If the lot's stored `allocation_method` is `'weight'` but a line is missing its weight, the assembly returns a `methodUnavailable` result instead of throwing — the Fiche renders the "méthode indisponible" reason instead of the margin card, and offers to switch method.
4. **"Période" for ad spend** = the existing required `spent_at` date column (single date field, single-column-per-screen rule). `window_start`/`window_end` stay `null` (not surfaced by this minimal UI); they remain available in the schema for a later lot.
5. **Idempotency key**: the client generates a UUID (`crypto.randomUUID()`) once per logical mutation. For `createProductAdSpendAction` it is written to `product_ad_spend.external_ref` (already unique per `merchant_account_id, shop_id` when non-null — exactly the mechanism needed); a retry hitting the unique-violation is treated as success. For the two `purchase_lot`/`purchase_lot_line` field updates (weight, allocation method), the mutation is naturally idempotent (it sets an absolute value), so the same client-generated id is only used as the mutation-queue record id, not sent to the server.

---

### Task 1: Aggregation RPC + assembly layer + actions (migration and its dependent code share ONE commit, per project's general batch-workflow rule — the founder's "separate commits" note in the F2 correction message is superseded by this explicit decision; STOP before `db push` after the single commit)

**Part A — the migration itself.**

**Files:**
- Create: `supabase/migrations/0146_lotF2_purchase_lot_profitability_rpc.sql`

**Interfaces:**
- Produces: `public.get_purchase_lot_profitability(p_purchase_lot_id uuid) returns jsonb`, callable by `authenticated` only, `security invoker` (RLS on `purchase_lot`/`purchase_lot_line` already restricts to `owner`; no redundant role guard needed since this function never bypasses RLS).
- Returns `null` if the lot is not visible/found (RLS-filtered or doesn't exist) — the assembly layer (Part B below) treats `null` as "not found."
- Returns shape:
  ```json
  {
    "purchaseLotId": "uuid",
    "transportTotalMinor": 0,
    "transportComplete": true,
    "allocationMethod": "value",
    "lines": [
      {
        "purchaseLotLineId": "uuid",
        "productId": "uuid",
        "qtyReceived": 20,
        "qtySold": 19,
        "purchaseValueMinor": 265200,
        "weightGrams": 5000,
        "cashCollectedMinor": 408000,
        "adSpendMinor": 66700
      }
    ]
  }
  ```

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================================
-- 0146 — Lot F2 : RPC d'agrégation pour la rentabilité par arrivage
-- ============================================================================
-- Dérogation de périmètre EXPLICITEMENT approuvée par le fondateur (2026-08-28) :
-- « aucune migration » du prompt F2 devient « aucune migration de données ou de
-- schéma, sauf une migration additive strictement limitée à la RPC d'agrégation
-- nécessaire au rendu ». Rien d'autre n'est touché ici.
--
-- Cette fonction n'AGRÈGE que — aucune formule métier (marge, marge %,
-- répartition du transport, complétude) n'est calculée en SQL. Toutes ces
-- règles restent dans lib/finance/lot-profitability.ts (Lot F1), réutilisé tel
-- quel côté TS. Si la formule était dupliquée ici, elle divergerait le jour où
-- l'une des deux copies serait corrigée sans l'autre.
--
-- SECURITY INVOKER, aucune garde de rôle : les policies RLS existantes de
-- purchase_lot/purchase_lot_line (owner-only, 0127) et de
-- purchase_lot_line_allocation (owner/manager/agent, 0145) s'appliquent déjà
-- sous l'identité de l'appelant — ajouter une garde ici serait redondant et,
-- pire, NULL-unsafe si mal écrite (cf. gotcha du projet). Un non-owner ou un
-- membre d'un autre tenant/boutique ne voit tout simplement aucune ligne :
-- la fonction renvoie NULL (lot introuvable de son point de vue), jamais une
-- erreur qui distinguerait "existe mais pas à vous" de "n'existe pas".
--
-- Ancrage strict sur l'arrivage autorisé : TOUTES les jointures partent de
-- `lot` (déjà filtré par p_purchase_lot_id ET par les policies RLS via
-- l'appelant) — jamais d'un identifiant enfant qui élargirait la portée.
-- ============================================================================

create or replace function public.get_purchase_lot_profitability(p_purchase_lot_id uuid)
returns jsonb
language sql
security invoker
stable
set search_path = ''
as $$
  with lot as (
    select id, transport_total, allocation_method
      from public.purchase_lot
     where id = p_purchase_lot_id
  ),
  lines as (
    select pll.id, pll.product_id, pll.qty as qty_received,
           pll.purchase_price_total, pll.weight_grams
      from public.purchase_lot_line pll
      join lot on lot.id = pll.purchase_lot_id
  ),
  -- Allocations FIFO nettes (sale/return/invalidation déjà signées, 0145) par
  -- (ligne de lot, commande) — jamais par ligne de commande seule : une même
  -- commande peut porter plusieurs lignes d'allocation compensatoires pour la
  -- même order_line_id (retour puis re-livraison), regroupées ici par order_id.
  alloc_by_order as (
    select a.purchase_lot_line_id, a.order_id, sum(a.qty) as qty
      from public.purchase_lot_line_allocation a
      join lines on lines.id = a.purchase_lot_line_id
     group by a.purchase_lot_line_id, a.order_id
    having sum(a.qty) <> 0
  ),
  qty_sold as (
    select purchase_lot_line_id, sum(qty) as qty_sold
      from alloc_by_order
     group by purchase_lot_line_id
  ),
  -- Quantité totale de lignes de commande matchées (tous produits confondus)
  -- par commande impliquée — sert de base de répartition du CA de la commande
  -- par unité (même principe que l'allocation des frais de livraison dans le
  -- pipeline Finances existant : parts égales par unité, jamais une formule de
  -- marge). Bornée aux commandes réellement impliquées dans CET arrivage.
  involved_orders as (
    select distinct order_id from alloc_by_order
  ),
  order_matched_qty as (
    select ol.order_id, sum(ol.qty) as matched_qty
      from public.order_line ol
      join involved_orders io on io.order_id = ol.order_id
     where ol.match_status = 'matched'
       and ol.product_id is not null
     group by ol.order_id
  ),
  -- CA imputé par ligne de lot : part au prorata des unités allouées à cette
  -- ligne sur le total_amount (déjà net des frais de livraison) de chaque
  -- commande où elle apparaît, arrondi commande par commande avant somme.
  line_cash as (
    select ao.purchase_lot_line_id,
           sum(round(ao.qty::numeric * o.total_amount / nullif(omq.matched_qty, 0)))::bigint
             as cash_collected_minor
      from alloc_by_order ao
      join public.orders o on o.id = ao.order_id
      join order_matched_qty omq on omq.order_id = ao.order_id
     group by ao.purchase_lot_line_id
  ),
  ad_spend as (
    select product_id, sum(amount_minor) as amount_minor
      from public.product_ad_spend
     where purchase_lot_id = p_purchase_lot_id
     group by product_id
  )
  select case
    when not exists (select 1 from lot) then null
    else jsonb_build_object(
      'purchaseLotId', p_purchase_lot_id,
      'transportTotalMinor', coalesce((select transport_total from lot), 0),
      'transportComplete', (select transport_total is not null from lot),
      'allocationMethod', (select allocation_method from lot),
      'lines', coalesce((
        select jsonb_agg(jsonb_build_object(
          'purchaseLotLineId', l.id,
          'productId', l.product_id,
          'qtyReceived', l.qty_received,
          'qtySold', coalesce(qs.qty_sold, 0),
          'purchaseValueMinor', coalesce(l.purchase_price_total, 0),
          'weightGrams', l.weight_grams,
          'cashCollectedMinor', coalesce(lc.cash_collected_minor, 0),
          'adSpendMinor', coalesce(ads.amount_minor, 0)
        ) order by l.id)
        from lines l
        left join qty_sold qs on qs.purchase_lot_line_id = l.id
        left join line_cash lc on lc.purchase_lot_line_id = l.id
        left join ad_spend ads on ads.product_id = l.product_id
      ), '[]'::jsonb)
    )
  end;
$$;

revoke all on function public.get_purchase_lot_profitability(uuid)
  from public, anon, authenticated;

grant execute on function public.get_purchase_lot_profitability(uuid)
  to authenticated;
```

Do not commit yet — the migration file is staged conceptually here; the actual `git add`/`git commit` happens once, at the end of Part C below, together with the code that depends on it.

---

**Part B — pure assembly layer over the RPC output** (no DB access, no dependency on the migration being applied; can be written and tested independently, but its commit is deferred to the end of Part C so the whole RPC-consuming unit lands in one commit).

**Files:**
- Create: `lib/finance/lot-profitability-assembly.ts`
- Test: `tests/unit/finance/lot-profitability-assembly.test.ts`

**Interfaces:**
- Consumes: `computeLotProductProfitability`, `isAllocationMethodAvailable`, types `AllocationMethod`, `LotProductLine`, `CostEntry` from `lib/finance/lot-profitability.ts` (unchanged).
- Produces:
  ```ts
  export type PurchaseLotProfitabilityRpcRow = {
    purchaseLotLineId: string;
    productId: string;
    qtyReceived: number;
    qtySold: number;
    purchaseValueMinor: number;
    weightGrams: number | null;
    cashCollectedMinor: number;
    adSpendMinor: number;
  };

  export type PurchaseLotProfitabilityRpcResult = {
    purchaseLotId: string;
    transportTotalMinor: number;
    transportComplete: boolean;
    allocationMethod: AllocationMethod;
    lines: PurchaseLotProfitabilityRpcRow[];
  };

  export type PurchaseLotLineProfitability = LotProductProfitability & {
    purchaseLotLineId: string;
  };

  export type PurchaseLotProfitabilitySummary =
    | {
        ok: true;
        allocationMethodAvailable: true;
        allocationMethod: AllocationMethod;
        lines: PurchaseLotLineProfitability[];
        totals: {
          cashCollectedMinor: number;
          costOfSoldMinor: number;
          adSpendMinor: number;
          marginMinor: number;
          marginPct: number;
          complete: boolean;
          missingInputs: string[];
          unsoldUnits: number;
          unsoldCostEngagedMinor: number;
          qtyReceived: number;
          qtySold: number;
        };
      }
    | { ok: true; allocationMethodAvailable: false; reason: 'missing_weight'; allocationMethod: AllocationMethod }
    | { ok: false; reason: 'not_found' };

  export function assemblePurchaseLotProfitability(
    rpc: PurchaseLotProfitabilityRpcResult | null,
  ): PurchaseLotProfitabilitySummary;
  ```

- [ ] **Step 1: Write the failing test (reference control + edge cases)**

```ts
import { assemblePurchaseLotProfitability } from '@/lib/finance/lot-profitability-assembly';
import { describe, expect, it } from 'vitest';

describe('assemblePurchaseLotProfitability — contrôle de référence (arrivage du 27 avril)', () => {
  it('reproduit exactement 89 360 F / 21,9 %', () => {
    const result = assemblePurchaseLotProfitability({
      purchaseLotId: 'lot-1',
      transportTotalMinor: 0,
      transportComplete: true,
      allocationMethod: 'value',
      lines: [
        {
          purchaseLotLineId: 'line-1',
          productId: 'p1',
          qtyReceived: 20,
          qtySold: 19,
          purchaseValueMinor: 265_200,
          weightGrams: 5_000,
          cashCollectedMinor: 408_000,
          adSpendMinor: 66_700,
        },
      ],
    });

    if (!result.ok || !result.allocationMethodAvailable) throw new Error('unexpected shape');
    expect(result.totals.marginMinor).toBe(89_360);
    expect(result.totals.marginPct).toBeCloseTo(0.219, 3);
    expect(result.totals.complete).toBe(true);
  });

  it('lot introuvable -> not_found', () => {
    const result = assemblePurchaseLotProfitability(null);
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('transport pas encore connu -> marge provisoire nommant le transport', () => {
    const result = assemblePurchaseLotProfitability({
      purchaseLotId: 'lot-1',
      transportTotalMinor: 0,
      transportComplete: false,
      allocationMethod: 'value',
      lines: [
        {
          purchaseLotLineId: 'line-1',
          productId: 'p1',
          qtyReceived: 10,
          qtySold: 5,
          purchaseValueMinor: 100_000,
          weightGrams: null,
          cashCollectedMinor: 80_000,
          adSpendMinor: 0,
        },
      ],
    });
    if (!result.ok || !result.allocationMethodAvailable) throw new Error('unexpected shape');
    expect(result.totals.complete).toBe(false);
    expect(result.totals.missingInputs).toContain('transport_total');
  });

  it("méthode 'weight' indisponible si un poids manque -> allocationMethodAvailable=false, raison nommée", () => {
    const result = assemblePurchaseLotProfitability({
      purchaseLotId: 'lot-1',
      transportTotalMinor: 10_000,
      transportComplete: true,
      allocationMethod: 'weight',
      lines: [
        {
          purchaseLotLineId: 'line-1',
          productId: 'p1',
          qtyReceived: 10,
          qtySold: 5,
          purchaseValueMinor: 100_000,
          weightGrams: null,
          cashCollectedMinor: 80_000,
          adSpendMinor: 0,
        },
      ],
    });
    expect(result).toEqual({
      ok: true,
      allocationMethodAvailable: false,
      reason: 'missing_weight',
      allocationMethod: 'weight',
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/unit/finance/lot-profitability-assembly.test.ts`
Expected: FAIL — module does not exist yet.

- [ ] **Step 3: Implement**

```ts
// lib/finance/lot-profitability-assembly.ts
// Assemble la sortie brute (agrégats seulement) de la RPC get_purchase_lot_profitability
// avec le moteur pur de F1 (lib/finance/lot-profitability.ts). Zéro accès base, zéro import
// `env`/Supabase ici — pure et testable sans base, même contrat que F1.
import {
  type AllocationMethod,
  type LotProductLine,
  type LotProductProfitability,
  computeLotProductProfitability,
  isAllocationMethodAvailable,
} from '@/lib/finance/lot-profitability';

export type PurchaseLotProfitabilityRpcRow = {
  purchaseLotLineId: string;
  productId: string;
  qtyReceived: number;
  qtySold: number;
  purchaseValueMinor: number;
  weightGrams: number | null;
  cashCollectedMinor: number;
  adSpendMinor: number;
};

export type PurchaseLotProfitabilityRpcResult = {
  purchaseLotId: string;
  transportTotalMinor: number;
  transportComplete: boolean;
  allocationMethod: AllocationMethod;
  lines: PurchaseLotProfitabilityRpcRow[];
};

export type PurchaseLotLineProfitability = LotProductProfitability & {
  purchaseLotLineId: string;
};

export type PurchaseLotProfitabilityTotals = {
  cashCollectedMinor: number;
  costOfSoldMinor: number;
  adSpendMinor: number;
  marginMinor: number;
  marginPct: number;
  complete: boolean;
  missingInputs: string[];
  unsoldUnits: number;
  unsoldCostEngagedMinor: number;
  qtyReceived: number;
  qtySold: number;
};

export type PurchaseLotProfitabilitySummary =
  | {
      ok: true;
      allocationMethodAvailable: true;
      allocationMethod: AllocationMethod;
      lines: PurchaseLotLineProfitability[];
      totals: PurchaseLotProfitabilityTotals;
    }
  | {
      ok: true;
      allocationMethodAvailable: false;
      reason: 'missing_weight';
      allocationMethod: AllocationMethod;
    }
  | { ok: false; reason: 'not_found' };

function toLotProductLine(row: PurchaseLotProfitabilityRpcRow): LotProductLine {
  return {
    productId: row.purchaseLotLineId, // clé d'allocation transport = LA LIGNE, jamais le produit (deux lignes du même produit dans un même lot sont possibles en théorie et doivent rester distinctes)
    qtyReceived: row.qtyReceived,
    qtySold: row.qtySold,
    purchaseValueMinor: row.purchaseValueMinor,
    weightGrams: row.weightGrams,
  };
}

export function assemblePurchaseLotProfitability(
  rpc: PurchaseLotProfitabilityRpcResult | null,
): PurchaseLotProfitabilitySummary {
  if (!rpc) {
    return { ok: false, reason: 'not_found' };
  }

  const allLines = rpc.lines.map(toLotProductLine);
  const availability = isAllocationMethodAvailable(allLines, rpc.allocationMethod);
  if (!availability.available) {
    return {
      ok: true,
      allocationMethodAvailable: false,
      reason: availability.reason ?? 'missing_weight',
      allocationMethod: rpc.allocationMethod,
    };
  }

  const lines: PurchaseLotLineProfitability[] = rpc.lines.map((row) => {
    const line = toLotProductLine(row);
    const profitability = computeLotProductProfitability({
      line,
      allLinesInLot: allLines,
      allocationMethod: rpc.allocationMethod,
      transportTotalMinor: rpc.transportTotalMinor,
      transportComplete: rpc.transportComplete,
      cashCollectedMinor: row.cashCollectedMinor,
      adSpend: { valueMinor: row.adSpendMinor, complete: true },
    });
    return { ...profitability, productId: row.productId, purchaseLotLineId: row.purchaseLotLineId };
  });

  const missingInputs = [...new Set(lines.flatMap((l) => l.missingInputs))];
  const totals: PurchaseLotProfitabilityTotals = {
    cashCollectedMinor: rpc.lines.reduce((s, r) => s + r.cashCollectedMinor, 0),
    costOfSoldMinor: lines.reduce((s, l) => s + l.costOfSoldMinor, 0),
    adSpendMinor: rpc.lines.reduce((s, r) => s + r.adSpendMinor, 0),
    marginMinor: lines.reduce((s, l) => s + l.marginMinor, 0),
    marginPct: 0,
    complete: missingInputs.length === 0,
    missingInputs,
    unsoldUnits: lines.reduce((s, l) => s + l.unsoldUnits, 0),
    unsoldCostEngagedMinor: lines.reduce((s, l) => s + l.unsoldCostEngagedMinor, 0),
    qtyReceived: rpc.lines.reduce((s, r) => s + r.qtyReceived, 0),
    qtySold: rpc.lines.reduce((s, r) => s + r.qtySold, 0),
  };
  totals.marginPct = totals.cashCollectedMinor === 0 ? 0 : totals.marginMinor / totals.cashCollectedMinor;

  return {
    ok: true,
    allocationMethodAvailable: true,
    allocationMethod: rpc.allocationMethod,
    lines,
    totals,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run tests/unit/finance/lot-profitability-assembly.test.ts`
Expected: PASS (all 4 cases).

Do not commit yet — proceed directly to Part C; everything lands in one commit at the end of Part C.

---

**Part C — read/write layer in `lib/actions/purchases.ts`.**

**Files:**
- Modify: `lib/actions/purchases.ts`

**Interfaces:**
- Consumes: `assemblePurchaseLotProfitability`, `PurchaseLotProfitabilityRpcResult` (Part B above); `requireRole` (`lib/actions/safe-action.ts`).
- Produces:
  - `getPurchaseLotProfitability(lotId: string): Promise<PurchaseLotProfitabilitySummary>` — server function (not a safe-action, mirrors `getPurchaseLotPageData`), calls the RPC via the **authenticated** client (never admin — RLS must gate this read).
  - `setPurchaseLotAllocationMethodAction` — input `{ lotId: string; method: 'value' | 'quantity' | 'weight' }`.
  - `setPurchaseLotLineWeightAction` — input `{ lotId: string; lineId: string; weightGrams: number | null }`.
  - `createProductAdSpendAction` — input `{ productId: string; purchaseLotId: string; amountMinor: number; spentAt: string; clientRequestId: string }`.

- [ ] **Step 1: Add the RPC binder + read function**

```ts
// Ajouts en tête de fichier, à côté de receivePurchaseLotRpc :
function getPurchaseLotProfitabilityRpc(client: { rpc: SupabaseClient<Database>['rpc'] }) {
  return client.rpc.bind(client) as unknown as (
    fn: 'get_purchase_lot_profitability',
    args: { p_purchase_lot_id: string },
  ) => Promise<{ data: PurchaseLotProfitabilityRpcResult | null; error: { message: string } | null }>;
}

// ── PROFITABILITY (Lot F2) ───────────────────────────────────────────────────

export async function getPurchaseLotProfitability(
  lotId: string,
): Promise<PurchaseLotProfitabilitySummary> {
  const supabase = await createSupabaseServerClient();
  const call = getPurchaseLotProfitabilityRpc(supabase);
  const { data, error } = await call('get_purchase_lot_profitability', { p_purchase_lot_id: lotId });

  if (error) return { ok: false, reason: 'not_found' };
  return assemblePurchaseLotProfitability(data);
}
```

Add the corresponding import line:
```ts
import {
  assemblePurchaseLotProfitability,
  type PurchaseLotProfitabilityRpcResult,
  type PurchaseLotProfitabilitySummary,
} from '@/lib/finance/lot-profitability-assembly';
import { isAllocationMethodAvailable } from '@/lib/finance/lot-profitability';
```

- [ ] **Step 2: Add `setPurchaseLotAllocationMethodAction`**

```ts
const allocationMethodSchema = z.object({
  lotId: z.string().uuid(),
  method: z.enum(['value', 'quantity', 'weight']),
});

export const setPurchaseLotAllocationMethodAction = requireRole('owner')
  .metadata({ actionName: 'purchases.set_allocation_method', section: 'purchases' })
  .inputSchema(allocationMethodSchema)
  .action(async ({ ctx, parsedInput }) => {
    const { merchantAccountId } = ctx.member;
    const admin = createSupabaseAdminClient();

    const { data: lines, error: lineErr } = await admin
      .from('purchase_lot_line')
      .select('weight_grams')
      .eq('purchase_lot_id', parsedInput.lotId)
      .eq('merchant_account_id', merchantAccountId);

    if (lineErr) return { ok: false as const, message: lineErr.message };

    if (parsedInput.method === 'weight') {
      const availability = isAllocationMethodAvailable(
        (lines ?? []).map((l) => ({ weightGrams: l.weight_grams })),
        'weight',
      );
      if (!availability.available) {
        return {
          ok: false as const,
          message: 'Poids manquant sur au moins une ligne : la répartition au poids est indisponible.',
        };
      }
    }

    const { error } = await admin
      .from('purchase_lot')
      .update({ allocation_method: parsedInput.method })
      .eq('id', parsedInput.lotId)
      .eq('merchant_account_id', merchantAccountId);

    if (error) return { ok: false as const, message: error.message };
    revalidatePath('/produits');
    return { ok: true as const };
  });
```

- [ ] **Step 3: Add `setPurchaseLotLineWeightAction`**

```ts
const setWeightSchema = z.object({
  lotId: z.string().uuid(),
  lineId: z.string().uuid(),
  weightGrams: z.number().int().min(0).nullable(),
});

export const setPurchaseLotLineWeightAction = requireRole('owner')
  .metadata({ actionName: 'purchases.set_line_weight', section: 'purchases' })
  .inputSchema(setWeightSchema)
  .action(async ({ ctx, parsedInput }) => {
    const { merchantAccountId } = ctx.member;
    const admin = createSupabaseAdminClient();

    const { error } = await admin
      .from('purchase_lot_line')
      .update({ weight_grams: parsedInput.weightGrams })
      .eq('id', parsedInput.lineId)
      .eq('purchase_lot_id', parsedInput.lotId)
      .eq('merchant_account_id', merchantAccountId);

    if (error) return { ok: false as const, message: error.message };
    revalidatePath('/produits');
    return { ok: true as const };
  });
```

- [ ] **Step 4: Add `createProductAdSpendAction` (owner-only, four fields required, idempotent)**

```ts
const createAdSpendSchema = z.object({
  productId: z.string().uuid(),
  purchaseLotId: z.string().uuid(), // jamais optionnel dans CETTE action — règle non négociable du prompt F2
  amountMinor: z.number().int().min(0),
  spentAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  clientRequestId: z.string().uuid(), // idempotence — écrit dans external_ref
});

const AD_SPEND_UNIQUE_EXTERNAL_REF_VIOLATION = '23505';

export const createProductAdSpendAction = requireRole('owner')
  .metadata({ actionName: 'purchases.create_ad_spend', section: 'purchases' })
  .inputSchema(createAdSpendSchema)
  .action(async ({ ctx, parsedInput }) => {
    const { merchantAccountId } = ctx.member;
    const admin = createSupabaseAdminClient();

    // Le produit ET le lot doivent être confrontés à leur parent autoritaire
    // (compte + boutique) AVANT toute écriture — motif récurrent du projet.
    const { data: product } = await admin
      .from('product')
      .select('id, shop_id')
      .eq('id', parsedInput.productId)
      .eq('merchant_account_id', merchantAccountId)
      .maybeSingle();
    if (!product) return { ok: false as const, message: 'Produit introuvable.' };

    const { data: lot } = await admin
      .from('purchase_lot')
      .select('id, shop_id')
      .eq('id', parsedInput.purchaseLotId)
      .eq('merchant_account_id', merchantAccountId)
      .maybeSingle();
    if (!lot) return { ok: false as const, message: 'Arrivage introuvable.' };
    if (lot.shop_id !== product.shop_id) {
      return { ok: false as const, message: "Ce produit n'appartient pas à cet arrivage." };
    }

    const { error } = await admin.from('product_ad_spend').insert({
      merchant_account_id: merchantAccountId,
      shop_id: product.shop_id,
      product_id: parsedInput.productId,
      purchase_lot_id: parsedInput.purchaseLotId,
      amount_minor: parsedInput.amountMinor,
      spent_at: parsedInput.spentAt,
      source: 'manuel',
      external_ref: parsedInput.clientRequestId,
      created_by: ctx.user.id,
    });

    if (error) {
      // Renvoi de la même mutation (offline queue) : le doublon est REFUSÉ par
      // l'index unique (merchant_account_id, shop_id, external_ref) — traité
      // comme un succès idempotent, jamais comme une erreur.
      if (error.code === AD_SPEND_UNIQUE_EXTERNAL_REF_VIOLATION) {
        return { ok: true as const, alreadyRecorded: true as const };
      }
      return { ok: false as const, message: error.message };
    }

    revalidatePath('/produits');
    return { ok: true as const, alreadyRecorded: false as const };
  });
```

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean (no new errors). Note: `getPurchaseLotProfitabilityRpc`'s cast exists precisely because `database.types.ts` doesn't know about `get_purchase_lot_profitability` yet (migration not pushed) — this is expected and temporary, not a defect to fix now.

- [ ] **Step 6: Single commit for the whole of Task 1 (Parts A+B+C) — migration and its dependent code together, per project rule**

```bash
git add supabase/migrations/0146_lotF2_purchase_lot_profitability_rpc.sql \
        lib/finance/lot-profitability-assembly.ts \
        tests/unit/finance/lot-profitability-assembly.test.ts \
        lib/actions/purchases.ts
git commit -m "phaseF: Lot F2 - migration + code : RPC d'agrégation rentabilité par arrivage"
```

- [ ] **Step 7: STOP.** Do not run `supabase db push`. Tell the developer the migration is ready; wait for them to push and confirm before Task 2's RLS tests (which need `supabase migration up --local`) and before regenerating `database.types.ts`. Once the developer confirms the push, Task 2 also closes the loop on removing `getPurchaseLotProfitabilityRpc`'s temporary cast once `database.types.ts` knows the function (per the F2 discipline note: "retrait des casts devenus inutiles dans le même lot").

---

### Task 2: RLS / mutation tests for the new RPC and actions

**Files:**
- Create: `tests/rls/lot-f2-purchase-lot-profitability.rls.test.ts`

**Preconditions:** developer has run `supabase db push` (Task 1's migration confirmed applied) and `pnpm exec supabase migration up --local` locally, then `pnpm db:types` (regenerates `lib/supabase/database.types.ts` — run `pnpm format` per project rule if biome complains).

**Interfaces:**
- Consumes: the RLS test harness pattern already established in `tests/rls/lot-f1-finances-v2-socle.rls.test.ts` (same helpers for creating a tenant/shop/owner/agent/second-tenant fixture — read that file first for the exact helper names before writing this one, since they are project-local, not documented here).

- [ ] **Step 1: Write the RLS test cases** (structure — adapt exact fixture helper calls from `lot-f1-finances-v2-socle.rls.test.ts`):

```ts
describe('get_purchase_lot_profitability — RLS', () => {
  it('owner du bon tenant/boutique lit le document complet', async () => {
    // seed: lot avec 1 ligne, transport_total=0, allocation_method='value',
    // une commande livrée-encaissée totale 408000 avec 19 unités matched
    // (qty=19 côté order_line), purchase_lot_line_allocation qty=19,
    // product_ad_spend amount_minor=66700, purchase_price_total=265200.
    const { data, error } = await ownerClient.rpc('get_purchase_lot_profitability', {
      p_purchase_lot_id: lotId,
    });
    expect(error).toBeNull();
    expect(data.lines[0].cashCollectedMinor).toBe(408_000);
    expect(data.lines[0].qtySold).toBe(19);
    expect(data.lines[0].adSpendMinor).toBe(66_700);
    // et via l'assemblage (import direct du module pur, pas la RPC) :
    const summary = assemblePurchaseLotProfitability(data);
    if (!summary.ok || !summary.allocationMethodAvailable) throw new Error('unexpected');
    expect(summary.totals.marginMinor).toBe(89_360);
    expect(Math.round(summary.totals.marginPct * 1000)).toBe(219);
  });

  it("arrivage d'une autre boutique du même tenant -> null", async () => {
    const { data } = await ownerClient.rpc('get_purchase_lot_profitability', {
      p_purchase_lot_id: otherShopLotId,
    });
    expect(data).toBeNull();
  });

  it("arrivage d'un autre tenant -> null", async () => {
    const { data } = await ownerOfOtherTenantClient.rpc('get_purchase_lot_profitability', {
      p_purchase_lot_id: lotId,
    });
    expect(data).toBeNull();
  });

  it('manager/agent -> null (owner-only, hérité de purchase_lot RLS)', async () => {
    const { data } = await managerClient.rpc('get_purchase_lot_profitability', {
      p_purchase_lot_id: lotId,
    });
    expect(data).toBeNull();
  });

  it('anon -> refusé (EXECUTE non accordé)', async () => {
    const { error } = await anonClient.rpc('get_purchase_lot_profitability', {
      p_purchase_lot_id: lotId,
    });
    expect(error).not.toBeNull();
  });
});

describe('createProductAdSpendAction — RBAC + tenant scoping (mutation-testé)', () => {
  it('owner peut créer une dépense publicitaire rattachée à un arrivage', async () => { /* ... */ });

  it('manager ne peut pas (refusé côté serveur, pas seulement masqué en UI)', async () => { /* ... */ });

  it('agent ne peut pas', async () => { /* ... */ });

  it("refuse un produit d'une autre boutique/tenant", async () => { /* ... */ });

  it("refuse un arrivage d'une autre boutique/tenant", async () => { /* ... */ });

  it('un renvoi du même clientRequestId ne crée pas de second enregistrement (idempotence)', async () => {
    const first = await createProductAdSpendAction(input);
    const second = await createProductAdSpendAction(input); // même clientRequestId
    expect(second?.data?.ok).toBe(true);
    const { count } = await admin
      .from('product_ad_spend')
      .select('id', { count: 'exact', head: true })
      .eq('external_ref', input.clientRequestId);
    expect(count).toBe(1);
  });

  it("MUTATION-TEST : retirer la contrainte purchaseLotId non-optionnelle fait échouer ce test — preuve que la contrainte est active", async () => {
    // Documente l'intention : ne pas exécuter un vrai retrait de code en CI, mais
    // vérifier que l'action rejette explicitement un payload sans purchaseLotId
    // (zod côté schema le fait déjà — ce test prouve le comportement observable).
    const res = await createProductAdSpendAction({ ...input, purchaseLotId: undefined } as never);
    expect(res?.data?.ok).not.toBe(true);
  });
});
```

- [ ] **Step 2: Run against local stack**

Run: `pnpm test:rls -- tests/rls/lot-f2-purchase-lot-profitability.rls.test.ts`
Expected: PASS. If `PGRST202 function not found`, run `pnpm exec supabase migration up --local` first (project gotcha: `db push` only touches remote).

- [ ] **Step 3: Regenerate types + baseline (only after the developer confirms the push)**

```bash
pnpm db:types
pnpm format
pnpm security:acl-baseline:generate
pnpm security:acl-baseline:check
```

- [ ] **Step 4: Remove the now-unnecessary cast in `getPurchaseLotProfitabilityRpc`** (`lib/actions/purchases.ts`, Task 1 Part C) — now that `database.types.ts` knows `get_purchase_lot_profitability`, call `supabase.rpc('get_purchase_lot_profitability', { p_purchase_lot_id: lotId })` directly and delete the manual binder function and its `as unknown as` cast. Re-run `pnpm typecheck`.

- [ ] **Step 5: Commit types/baseline/cast-removal separately from the RLS test commit if they land in different sessions**

```bash
git add tests/rls/lot-f2-purchase-lot-profitability.rls.test.ts
git commit -m "phaseF: Lot F2 - tests RLS : RPC agrégation + RBAC dépense publicitaire"
# séparément, une fois le push confirmé :
git add lib/supabase/database.types.ts supabase/security/acl-baseline.json lib/actions/purchases.ts
git commit -m "phaseF: Lot F2 - types + baseline ACL régénérés, retrait du cast temporaire (0146)"
```

---

### Task 3: Offline durable mutation queue (core, generic)

**Files:**
- Create: `lib/offline/mutation-queue.ts`
- Test: `tests/unit/offline/mutation-queue.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type QueuedMutationStatus = 'queued' | 'synced';
  export type QueuedMutation<TInput = unknown> = {
    id: string;
    kind: string;
    input: TInput;
    createdAt: string;
    attempts: number;
    lastError?: string;
  };

  export function enqueueMutation<TInput>(kind: string, input: TInput, id?: string): Promise<QueuedMutation<TInput>>;
  export function listQueuedMutations(): Promise<QueuedMutation[]>;
  export function flushMutationQueue(
    executors: Record<string, (input: unknown) => Promise<{ ok: boolean }>>,
  ): Promise<void>;
  export function onMutationSettled(id: string, handler: () => void): () => void; // unsubscribe
  export function initMutationQueueAutoFlush(
    executors: Record<string, (input: unknown) => Promise<{ ok: boolean }>>,
  ): () => void; // wires 'online' listener + one immediate flush; returns cleanup
  ```
- Uses raw `indexedDB` (database `teer-mutation-queue`, store `mutations`, `keyPath: 'id'`) — no new npm dependency.

- [ ] **Step 1: Write the failing unit test (with `fake-indexeddb`, already usable via Vitest's jsdom environment — check `vitest.config.ts` for an existing jsdom-environment test to confirm IndexedDB is polyfilled; if not, add `fake-indexeddb/auto` as a dev-only test setup import, never a runtime dependency)**

```ts
import 'fake-indexeddb/auto';
import {
  enqueueMutation,
  flushMutationQueue,
  listQueuedMutations,
  onMutationSettled,
} from '@/lib/offline/mutation-queue';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(async () => {
  const all = await listQueuedMutations();
  await flushMutationQueue(
    Object.fromEntries(all.map((m) => [m.kind, async () => ({ ok: true })])),
  );
});

describe('mutation-queue', () => {
  it('enqueue puis flush réussi retire la mutation de la file', async () => {
    const record = await enqueueMutation('set_weight', { lineId: 'l1', weightGrams: 500 });
    expect((await listQueuedMutations()).map((m) => m.id)).toContain(record.id);

    await flushMutationQueue({ set_weight: async () => ({ ok: true }) });

    expect((await listQueuedMutations()).map((m) => m.id)).not.toContain(record.id);
  });

  it('flush en échec laisse la mutation en file avec attempts incrémenté', async () => {
    const record = await enqueueMutation('set_weight', { lineId: 'l1', weightGrams: 500 });
    await flushMutationQueue({ set_weight: async () => ({ ok: false }) });

    const remaining = await listQueuedMutations();
    const found = remaining.find((m) => m.id === record.id);
    expect(found).toBeDefined();
    expect(found?.attempts).toBe(1);
  });

  it('onMutationSettled notifie exactement au retrait de la file (pas avant)', async () => {
    const record = await enqueueMutation('set_weight', { lineId: 'l1', weightGrams: 500 });
    const settled = vi.fn();
    const unsubscribe = onMutationSettled(record.id, settled);

    await flushMutationQueue({ set_weight: async () => ({ ok: false }) });
    expect(settled).not.toHaveBeenCalled();

    await flushMutationQueue({ set_weight: async () => ({ ok: true }) });
    expect(settled).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('id explicite (idempotence) : enqueue avec le même id ne crée pas deux entrées', async () => {
    const fixedId = 'fixed-uuid-1';
    await enqueueMutation('create_ad_spend', { amountMinor: 1000 }, fixedId);
    await enqueueMutation('create_ad_spend', { amountMinor: 1000 }, fixedId);

    const all = await listQueuedMutations();
    expect(all.filter((m) => m.id === fixedId)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/unit/offline/mutation-queue.test.ts`
Expected: FAIL — module/dependency missing.

- [ ] **Step 3: Add the dev dependency and implement**

```bash
pnpm add -D fake-indexeddb
```

```ts
// lib/offline/mutation-queue.ts
// File durable générique de mutations, IndexedDB pur (aucune dépendance runtime
// nouvelle — `fake-indexeddb` n'est qu'un devDependency de test). Deux garanties :
// (1) une mutation survit à la fermeture de l'app tant qu'elle n'a pas été
//     confirmée par le serveur (suppression SEULEMENT après ok:true) ;
// (2) un id explicite (fourni par l'appelant, ex. product_ad_spend.external_ref)
//     rend l'enqueue lui-même idempotent — un second enqueue avec le même id
//     écrase l'entrée existante, jamais n'en crée une seconde.
const DB_NAME = 'teer-mutation-queue';
const STORE_NAME = 'mutations';
const DB_VERSION = 1;

export type QueuedMutation<TInput = unknown> = {
  id: string;
  kind: string;
  input: TInput;
  createdAt: string;
  attempts: number;
  lastError?: string;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const request = fn(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function generateId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function enqueueMutation<TInput>(
  kind: string,
  input: TInput,
  id?: string,
): Promise<QueuedMutation<TInput>> {
  const record: QueuedMutation<TInput> = {
    id: id ?? generateId(),
    kind,
    input,
    createdAt: new Date().toISOString(),
    attempts: 0,
  };
  await withStore('readwrite', (store) => store.put(record));
  return record;
}

export async function listQueuedMutations(): Promise<QueuedMutation[]> {
  return withStore('readonly', (store) => store.getAll());
}

const settledListeners = new Map<string, Set<() => void>>();

export function onMutationSettled(id: string, handler: () => void): () => void {
  const set = settledListeners.get(id) ?? new Set();
  set.add(handler);
  settledListeners.set(id, set);
  return () => {
    settledListeners.get(id)?.delete(handler);
  };
}

function notifySettled(id: string) {
  for (const handler of settledListeners.get(id) ?? []) handler();
  settledListeners.delete(id);
}

export async function flushMutationQueue(
  executors: Record<string, (input: unknown) => Promise<{ ok: boolean }>>,
): Promise<void> {
  const all = await listQueuedMutations();
  for (const record of all) {
    const executor = executors[record.kind];
    if (!executor) continue;

    try {
      const result = await executor(record.input);
      if (result.ok) {
        await withStore('readwrite', (store) => store.delete(record.id));
        notifySettled(record.id);
      } else {
        await withStore('readwrite', (store) =>
          store.put({ ...record, attempts: record.attempts + 1, lastError: 'rejected' }),
        );
      }
    } catch (err) {
      await withStore('readwrite', (store) =>
        store.put({
          ...record,
          attempts: record.attempts + 1,
          lastError: err instanceof Error ? err.message : 'unknown_error',
        }),
      );
    }
  }
}

export function initMutationQueueAutoFlush(
  executors: Record<string, (input: unknown) => Promise<{ ok: boolean }>>,
): () => void {
  const handleOnline = () => {
    void flushMutationQueue(executors);
  };
  window.addEventListener('online', handleOnline);
  void flushMutationQueue(executors); // rattrape les mutations laissées par une session précédente
  return () => window.removeEventListener('online', handleOnline);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run tests/unit/offline/mutation-queue.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/offline/mutation-queue.ts tests/unit/offline/mutation-queue.test.ts package.json pnpm-lock.yaml
git commit -m "phaseF: Lot F2 - code : file durable de mutations offline (IndexedDB)"
```

---

### Task 4: `useQueuedAction` hook — wires the queue to a next-safe-action call with explicit button states

**Files:**
- Create: `lib/offline/use-queued-action.ts`

**Interfaces:**
- Consumes: `enqueueMutation`, `onMutationSettled`, `flushMutationQueue` (Task 3).
- Produces:
  ```ts
  export type QueuedActionState = 'idle' | 'saving' | 'queued' | 'synced' | 'error';
  export function useQueuedAction<TInput>(
    kind: string,
    executor: (input: TInput) => Promise<{ ok: boolean; message?: string }>,
  ): {
    state: QueuedActionState;
    errorMessage: string | null;
    submit: (input: TInput, idempotencyKey?: string) => Promise<void>;
  };
  ```

- [ ] **Step 1: Implement (no test file — this is a thin React wiring layer over already-tested primitives; covered end-to-end by the E2E offline test in Task 8)**

```ts
'use client';

import { enqueueMutation, flushMutationQueue, onMutationSettled } from '@/lib/offline/mutation-queue';
import { useCallback, useRef, useState } from 'react';

export type QueuedActionState = 'idle' | 'saving' | 'queued' | 'synced' | 'error';

export function useQueuedAction<TInput>(
  kind: string,
  executor: (input: TInput) => Promise<{ ok: boolean; message?: string }>,
) {
  const [state, setState] = useState<QueuedActionState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const executorRef = useRef(executor);
  executorRef.current = executor;

  const submit = useCallback(
    async (input: TInput, idempotencyKey?: string) => {
      setState('saving');
      setErrorMessage(null);

      const record = await enqueueMutation(kind, input, idempotencyKey);

      const unsubscribe = onMutationSettled(record.id, () => setState('synced'));

      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setState('queued');
        return;
      }

      await flushMutationQueue({
        [kind]: async (queuedInput: unknown) => {
          try {
            const result = await executorRef.current(queuedInput as TInput);
            if (!result.ok && result.message) setErrorMessage(result.message);
            return { ok: result.ok };
          } catch {
            return { ok: false };
          }
        },
      });

      // Si toujours en file après une tentative immédiate (échec réseau furtif),
      // l'état visible passe à "en attente" — le prochain 'online' la reprendra.
      setState((current) => (current === 'saving' ? 'queued' : current));
      unsubscribe();
    },
    [kind],
  );

  return { state, errorMessage, submit };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add lib/offline/use-queued-action.ts
git commit -m "phaseF: Lot F2 - code : hook useQueuedAction (états de bouton explicites)"
```

---

### Task 5: "Fiche arrivage" detail panel

**Files:**
- Create: `components/purchases/purchase-lot-detail-panel.tsx`
- Modify: `components/purchases/purchase-lots-view.tsx` (wire the trigger + margin/marge%/avancement on `LotCard`)

**Interfaces:**
- Consumes: `getPurchaseLotProfitability`, `setPurchaseLotAllocationMethodAction`, `setPurchaseLotLineWeightAction` (Task 1, Part C); `useQueuedAction` (Task 4); `DetailPanel`, `Amount`, `ValueAmount`, `GainLoss`, `ScopedMetricCard`, `ExplanationCard`, `ListCard` (existing U1-F components, signatures already captured in the research above — reuse verbatim, do not modify their props).
- `PurchaseLotData` (existing type in `lib/actions/purchases.ts`) gains no new field — profitability is fetched lazily when the panel opens (`getPurchaseLotProfitability` is a server function; call it from a client component via a thin wrapping server action, OR fetch it server-side in the parent page and pass down — **prefer passing from the page** to avoid adding a client-callable RPC surface: `app/(app)/produits/page.tsx`'s `achats` branch already awaits `getPurchaseLotPageData`; extend it to also await `Promise.all(lots.map(l => getPurchaseLotProfitability(l.id)))` only for `status === 'received'` lots, and pass a `profitabilityByLotId: Record<string, PurchaseLotProfitabilitySummary>` prop down to `PurchaseLotsView`).

- [ ] **Step 1: Extend the page loader** (`app/(app)/produits/page.tsx`, `achats` branch)

```ts
// Après avoir chargé purchaseResult :
const profitabilityEntries = purchaseResult.ok
  ? await Promise.all(
      purchaseResult.lots
        .filter((lot) => lot.status === 'received')
        .map(async (lot) => [lot.id, await getPurchaseLotProfitability(lot.id)] as const),
    )
  : [];
const profitabilityByLotId = Object.fromEntries(profitabilityEntries);
```
Pass `profitabilityByLotId={profitabilityByLotId}` to `<PurchaseLotsView />`.

- [ ] **Step 2: `LotCard` — margin/marge%/avancement on the list card**

Add to `LotCard` props: `profitability?: PurchaseLotProfitabilitySummary`. Render, right under the existing grid of metadata, only when `profitability?.ok && profitability.allocationMethodAvailable`:

```tsx
{profitability?.ok && profitability.allocationMethodAvailable && (
  <div className="flex flex-wrap items-center gap-4 border-t border-border pt-3">
    <GainLoss
      amountMinor={profitability.totals.marginMinor}
      labels={{ gain: 'Marge', loss: 'Marge', neutral: 'Marge nulle' }}
    />
    <span className="text-sm text-muted">
      {(profitability.totals.marginPct * 100).toFixed(1)} %
    </span>
    <span className="text-sm text-muted">
      {profitability.totals.qtySold} / {profitability.totals.qtyReceived} vendus
    </span>
    {!profitability.totals.complete && (
      <span className="text-xs text-warning">Marge provisoire</span>
    )}
    <button
      type="button"
      onClick={() => setDetailOpen(true)}
      className="ml-auto min-h-11 rounded-md border border-border px-3 text-sm font-medium text-text hover:bg-canvas"
    >
      Voir la rentabilité
    </button>
  </div>
)}
{profitability?.ok && !profitability.allocationMethodAvailable && (
  <p className="text-xs text-warning">
    Répartition au poids indisponible : au moins une ligne n'a pas de poids renseigné.
  </p>
)}
```
(`GainLoss`'s "loss" label is reused for a negative margin — a negative margin genuinely is a loss, consistent with the component's contract.)

- [ ] **Step 3: Build `PurchaseLotDetailPanel`** — order per spec: marge (title), CA encaissé, coût de revient des vendus, dépenses pub + coût pub/vente, marge %, invendu (carte distincte), avancement, puis méthode+effet par produit.

```tsx
'use client';

import { ExplanationCard, type ExplanationCardRow } from '@/components/ui/explanation-card';
import { DetailPanel } from '@/components/ui/detail-panel';
import { Amount } from '@/components/ui/amount';
import { GainLoss } from '@/components/ui/gain-loss';
import { ListCard } from '@/components/ui/list-card';
import { ScopedMetricCard } from '@/components/ui/scoped-metric-card';
import type { PurchaseLotProfitabilitySummary } from '@/lib/finance/lot-profitability-assembly';
import type { PurchaseLotData } from '@/lib/actions/purchases';
import { setPurchaseLotAllocationMethodAction, setPurchaseLotLineWeightAction } from '@/lib/actions/purchases';
import { useQueuedAction } from '@/lib/offline/use-queued-action';
import { useAction } from 'next-safe-action/hooks';
import { useState } from 'react';

const METHOD_LABELS: Record<'value' | 'quantity' | 'weight', string> = {
  value: 'À la valeur',
  quantity: 'À la quantité',
  weight: 'Au poids',
};

export function PurchaseLotDetailPanel({
  lot,
  profitability,
  open,
  onClose,
}: {
  lot: PurchaseLotData;
  profitability: PurchaseLotProfitabilitySummary;
  open: boolean;
  onClose: () => void;
}) {
  const setMethod = useAction(setPurchaseLotAllocationMethodAction);
  const weightAction = useQueuedAction('set_weight', async (input: { lotId: string; lineId: string; weightGrams: number | null }) => {
    const res = await setPurchaseLotLineWeightAction(input);
    return { ok: Boolean(res?.data?.ok), message: res?.data?.ok ? undefined : res?.data?.message };
  });

  if (!profitability.ok) {
    return (
      <DetailPanel closeLabel="Fermer" open={open} title={lot.supplierName} onClose={onClose}>
        <p className="p-4 text-sm text-muted">Arrivage introuvable ou pas encore reçu.</p>
      </DetailPanel>
    );
  }

  if (!profitability.allocationMethodAvailable) {
    return (
      <DetailPanel closeLabel="Fermer" open={open} title={lot.supplierName} onClose={onClose}>
        <div className="space-y-3 p-4">
          <p className="text-sm text-warning">
            Répartition au poids indisponible : au moins une ligne n'a pas de poids renseigné.
          </p>
          <MethodSelector lot={lot} current={profitability.allocationMethod} setMethod={setMethod} />
          <WeightEditor lot={lot} weightAction={weightAction} />
        </div>
      </DetailPanel>
    );
  }

  const { totals, lines } = profitability;

  const marginRows: ExplanationCardRow[] = [
    { sentence: 'Vous avez encaissé', sign: 'add', state: { kind: 'confirmed', amountMinor: totals.cashCollectedMinor } },
    { sentence: 'Les articles vendus vous ont coûté', sign: 'subtract', state: { kind: 'confirmed', amountMinor: totals.costOfSoldMinor } },
    { sentence: 'La publicité vous a coûté', sign: 'subtract', state: { kind: 'confirmed', amountMinor: totals.adSpendMinor } },
    ...(totals.missingInputs.includes('transport_total')
      ? [{ sentence: "Le transport de l'arrivage vous a coûté", sign: 'subtract', state: { kind: 'missing' } } satisfies ExplanationCardRow]
      : []),
  ];

  return (
    <DetailPanel closeLabel="Fermer" open={open} title={`Rentabilité — ${lot.supplierName}`} onClose={onClose}>
      <div className="space-y-4 p-4">
        <ExplanationCard
          label="Marge"
          rows={marginRows}
          scope={{ kind: 'balance', asOfLabel: lot.receivedAt ?? lot.orderedAt }}
          totalSentence="Marge de l'arrivage"
        />
        {!totals.complete && (
          <p className="text-xs text-warning">
            Marge provisoire — coût manquant : {totals.missingInputs.join(', ')}.
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <ScopedMetricCard
            label="CA encaissé"
            scope={{ kind: 'balance', asOfLabel: lot.receivedAt ?? lot.orderedAt }}
            value={<Amount amountMinor={totals.cashCollectedMinor} />}
          />
          <ScopedMetricCard
            label="Coût de revient des vendus"
            scope={{ kind: 'balance', asOfLabel: lot.receivedAt ?? lot.orderedAt }}
            value={<Amount amountMinor={totals.costOfSoldMinor} />}
          />
          <ScopedMetricCard
            label="Dépenses publicitaires"
            scope={{ kind: 'balance', asOfLabel: lot.receivedAt ?? lot.orderedAt }}
            value={<Amount amountMinor={totals.adSpendMinor} />}
          />
          <ScopedMetricCard
            label="Marge %"
            scope={{ kind: 'balance', asOfLabel: lot.receivedAt ?? lot.orderedAt }}
            value={<span className="text-2xl font-semibold">{(totals.marginPct * 100).toFixed(1)} %</span>}
          />
        </div>

        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-sm font-medium text-text">Invendu</p>
          <div className="mt-2 flex items-baseline gap-3">
            <span className="text-2xl font-semibold text-text">{totals.unsoldUnits}</span>
            <span className="text-sm text-muted">unités —</span>
            <Amount amountMinor={totals.unsoldCostEngagedMinor} className="text-lg font-semibold" />
            <span className="text-sm text-muted">de coût de revient engagé</span>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-surface p-4">
          <p className="text-sm font-medium text-text">Avancement des ventes</p>
          <p className="mt-1 text-sm text-muted">
            {totals.qtySold} vendues / {totals.qtyReceived - totals.qtySold} restantes
          </p>
        </div>

        <section className="space-y-2">
          <p className="text-sm font-medium text-text">Répartition du transport</p>
          <MethodSelector lot={lot} current={profitability.allocationMethod} setMethod={setMethod} />
          {lines.map((line) => (
            <ListCard
              key={line.purchaseLotLineId}
              title={line.productId}
              primaryValue={<Amount amountMinor={line.allocatedTransportMinor} />}
              secondary={[
                { label: "Coût de revient rendu", value: <Amount amountMinor={line.landedUnitCostMinor} /> },
                { label: 'Coût publicitaire / vente', value: line.adSpendPerUnitMinor == null ? '—' : <Amount amountMinor={line.adSpendPerUnitMinor} /> },
              ]}
            />
          ))}
          <WeightEditor lot={lot} weightAction={weightAction} />
        </section>
      </div>
    </DetailPanel>
  );
}
```

`MethodSelector` and `WeightEditor` are small private sub-components in the same file (three radio/segmented options for method; one numeric field — label above, validate-on-blur, explicit "Enregistrer" button per line — for weight). Write them following the exact numeric-input conventions already used in `purchase-lots-view.tsx` (`type="number" min={0}`, `min-h-11`, thousands display via `Amount`/`formatMoney`-free plain integer since grams have no currency formatting).

- [ ] **Step 4: Wire the trigger from `PurchaseLotsView`**

In `purchase-lots-view.tsx`'s `LotCard`, add local state `const [detailOpen, setDetailOpen] = useState(false);` and render `<PurchaseLotDetailPanel lot={lot} profitability={profitability} open={detailOpen} onClose={() => setDetailOpen(false)} />` when `profitability` is defined. Thread `profitability` through `PurchaseLotsView`'s props (`profitabilityByLotId`) down to each `LotCard`.

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`

- [ ] **Step 6: Commit**

```bash
git add app/\(app\)/produits/page.tsx components/purchases/purchase-lots-view.tsx components/purchases/purchase-lot-detail-panel.tsx
git commit -m "phaseF: Lot F2 - écran : fiche arrivage (marge, CA, coûts, invendu, avancement)"
```

---

### Task 6: Ad-spend form — reusable, four fields, lot resolution from product context

**Files:**
- Create: `components/purchases/product-ad-spend-form.tsx`
- Modify: `components/purchases/purchase-lot-detail-panel.tsx` (mount it with `purchaseLotId` fixed to the open lot)
- Modify: `components/products/product-detail-panel.tsx` (owner-only entry point; resolve candidate lots)

**Interfaces:**
- Consumes: `createProductAdSpendAction` (Task 1, Part C), `useQueuedAction` (Task 4).
- Produces: `ProductAdSpendForm({ productId: string; lockedPurchaseLotId?: string; candidateLots?: { id: string; label: string }[]; onDone: () => void })`. If `lockedPurchaseLotId` is set (opened from the Fiche arrivage), the lot is displayed read-only. If `candidateLots` is set instead (opened from the product page), render a required `<select>`; if it has exactly one entry, preselect it but still show it (not hidden) so the merchant sees which arrivage is being charged.

- [ ] **Step 1: Implement the form**

```tsx
'use client';

import { createProductAdSpendAction } from '@/lib/actions/purchases';
import { useQueuedAction } from '@/lib/offline/use-queued-action';
import { useState } from 'react';

type CandidateLot = { id: string; label: string };

export function ProductAdSpendForm({
  productId,
  lockedPurchaseLotId,
  candidateLots,
  onDone,
}: {
  productId: string;
  lockedPurchaseLotId?: string;
  candidateLots?: CandidateLot[];
  onDone: () => void;
}) {
  const [purchaseLotId, setPurchaseLotId] = useState(
    lockedPurchaseLotId ?? (candidateLots?.length === 1 ? candidateLots[0].id : ''),
  );
  const [amountText, setAmountText] = useState('');
  const [spentAt, setSpentAt] = useState(new Date().toISOString().slice(0, 10));
  const [amountError, setAmountError] = useState<string | null>(null);

  const queued = useQueuedAction('create_ad_spend', async (input: Parameters<typeof createProductAdSpendAction>[0]) => {
    const res = await createProductAdSpendAction(input);
    return { ok: Boolean(res?.data?.ok), message: res?.data?.ok ? undefined : res?.data?.message };
  });

  function formatThousands(raw: string): string {
    const digits = raw.replace(/\D/g, '');
    return digits ? Number(digits).toLocaleString('fr-FR') : '';
  }

  function validateAmountOnBlur() {
    const digits = amountText.replace(/\D/g, '');
    if (!digits || Number(digits) <= 0) setAmountError('Montant requis, supérieur à 0.');
    else setAmountError(null);
  }

  async function submit() {
    validateAmountOnBlur();
    if (!purchaseLotId) return; // le select required bloque déjà côté UI
    const digits = amountText.replace(/\D/g, '');
    if (!digits || Number(digits) <= 0) return;

    await queued.submit(
      {
        productId,
        purchaseLotId,
        amountMinor: Number(digits),
        spentAt,
        clientRequestId: crypto.randomUUID(),
      },
      crypto.randomUUID(),
    );
    if (queued.state !== 'error') onDone();
  }

  const buttonLabel =
    queued.state === 'saving'
      ? 'Enregistrer'
      : queued.state === 'queued'
        ? "Enregistré sur l'appareil — en attente de synchronisation"
        : queued.state === 'synced'
          ? 'Enregistré'
          : 'Enregistrer';

  return (
    <div className="space-y-4">
      {!lockedPurchaseLotId && candidateLots && candidateLots.length > 1 && (
        <label className="block space-y-1">
          <span className="text-sm font-medium text-text">Arrivage *</span>
          <select
            required
            value={purchaseLotId}
            onChange={(e) => setPurchaseLotId(e.target.value)}
            className="min-h-11 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
          >
            <option value="">Sélectionnez l'arrivage concerné…</option>
            {candidateLots.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </label>
      )}
      {!lockedPurchaseLotId && candidateLots && candidateLots.length === 0 && (
        <p className="text-sm text-warning">
          Ce produit n'a pas encore d'arrivage reçu — la dépense publicitaire doit être rattachée à un arrivage.
        </p>
      )}
      {!lockedPurchaseLotId && candidateLots && candidateLots.length === 1 && (
        <p className="text-sm text-muted">Arrivage : {candidateLots[0].label}</p>
      )}

      <label className="block space-y-1">
        <span className="text-sm font-medium text-text">Montant</span>
        <input
          inputMode="numeric"
          value={amountText}
          onChange={(e) => setAmountText(formatThousands(e.target.value))}
          onBlur={validateAmountOnBlur}
          className="min-h-11 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm font-mono tabular-nums"
          placeholder="0"
        />
        {amountError && <span className="text-xs text-danger">{amountError}</span>}
      </label>

      <label className="block space-y-1">
        <span className="text-sm font-medium text-text">Date</span>
        <input
          type="date"
          value={spentAt}
          onChange={(e) => setSpentAt(e.target.value)}
          className="min-h-11 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
        />
      </label>

      <button
        type="button"
        onClick={submit}
        disabled={
          queued.state === 'saving' ||
          !purchaseLotId ||
          (candidateLots && candidateLots.length === 0)
        }
        className="min-h-[44px] w-full rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50"
      >
        {buttonLabel}
      </button>
      {queued.errorMessage && <p className="text-xs text-danger">{queued.errorMessage}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Mount from the Fiche arrivage** — add a "+ Ajouter une dépense publicitaire" button per `ListCard` line (or a section-level button) in `purchase-lot-detail-panel.tsx` that opens a nested `DetailPanel` (or an inline reveal, matching "un enregistrement à la fois") rendering `<ProductAdSpendForm productId={line.productId} lockedPurchaseLotId={lot.id} onDone={...} />`.

- [ ] **Step 3: Mount from the product detail panel** — in `components/products/product-detail-panel.tsx`, gate a new owner-only section on the caller's role (read the file first to find how role is already threaded into this component — it already hides `unit_cost` from `agent`, so the same prop/pattern applies). Resolve `candidateLots` server-side (in the page/data-loader that already feeds this panel) via:

```ts
const { data: candidateLotRows } = await admin
  .from('purchase_lot_line')
  .select('purchase_lot_id, purchase_lot!inner(id, supplier_name, received_at, status)')
  .eq('product_id', productId)
  .eq('purchase_lot.status', 'received')
  .eq('merchant_account_id', merchantAccountId)
  .order('purchase_lot(received_at)', { ascending: false });

const candidateLots = (candidateLotRows ?? []).map((r) => ({
  id: r.purchase_lot_id,
  label: `${r.purchase_lot.supplier_name} — ${r.purchase_lot.received_at}`,
}));
```

- [ ] **Step 4: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`

- [ ] **Step 5: Commit**

```bash
git add components/purchases/product-ad-spend-form.tsx components/purchases/purchase-lot-detail-panel.tsx components/products/product-detail-panel.tsx
git commit -m "phaseF: Lot F2 - écran : saisie dépense publicitaire (produit+arrivage+période+montant)"
```

---

### Task 7: RBAC UI gating for ad spend (mirrors server, doesn't replace it)

**Files:**
- Modify: `components/products/product-detail-panel.tsx`, `components/purchases/purchase-lot-detail-panel.tsx`

- [ ] **Step 1:** Confirm the ad-spend entry points render `null`/nothing for `role !== 'owner'` (both the button/trigger AND the mounted form) — read from whatever role prop already flows into each parent (the `achats` tab is already `isOwner`-gated at the page level per `app/(app)/produits/page.tsx:28`, so `purchase-lot-detail-panel.tsx` needs no extra gating; `product-detail-panel.tsx` is reachable by `manager`/`agent` too — gate explicitly there).

- [ ] **Step 2:** Add a unit test asserting the gate:

```ts
// tests/unit/products/product-detail-panel-ad-spend-gate.test.tsx
// Rend ProductDetailPanel avec role='manager' puis role='agent' : le bouton
// "Ajouter une dépense publicitaire" est absent du DOM dans les deux cas ;
// présent avec role='owner'.
```

- [ ] **Step 3:** Run `pnpm vitest run tests/unit/products/product-detail-panel-ad-spend-gate.test.tsx` — PASS.

- [ ] **Step 4: Commit**

```bash
git add components/products/product-detail-panel.tsx tests/unit/products/product-detail-panel-ad-spend-gate.test.tsx
git commit -m "phaseF: Lot F2 - garde UI : saisie publicité masquée hors owner (miroir du serveur)"
```

---

### Task 8: E2E proofs (responsive, offline queue, ad-spend-requires-lot)

**Files:**
- Create: `tests/e2e/lot-f2-purchase-lot-detail.spec.ts`

- [ ] **Step 1: Write the specs**

```ts
import { expect, test } from '@playwright/test';

test.describe('Lot F2 — fiche arrivage', () => {
  test.use({ viewport: { width: 412, height: 915 } }); // pixel-7

  test('aucun montant tronqué ni débordement à 412px', async ({ page }) => {
    // login owner (seed fixture), naviguer /produits?tab=achats, ouvrir "Voir la rentabilité"
    // sur l'arrivage seedé avec la référence 89 360 F / 21,9 %.
    // Mesurer scrollWidth === clientWidth sur l'élément [data-testid="amount"] de chaque montant.
  });

  test('marge provisoire ET masquage distinct sur le même écran', async ({ page }) => {
    // seed un second arrivage avec transport_total=null (marge provisoire) et une
    // ligne SANS purchase_price_total du tout pour prouver le masquage de valeur
    // dérivée séparément (déjà garanti par ValueAmount, vérifié ici en intégration).
  });
});

test.describe('Lot F2 — file durable hors-ligne (proof 5)', () => {
  test('coupure réseau après clic Enregistrer -> file -> reprise au retour réseau, sans doublon', async ({ page, context }) => {
    // 1. Ouvrir la fiche arrivage, ouvrir l'éditeur de poids d'une ligne.
    // 2. context.setOffline(true)
    // 3. Saisir un poids, cliquer Enregistrer -> attendre le libellé
    //    "Enregistré sur l'appareil — en attente de synchronisation".
    // 4. page.reload() -- prouve la survie à la fermeture (IndexedDB persiste).
    // 5. context.setOffline(false)
    // 6. Attendre le libellé "Enregistré".
    // 7. Lire purchase_lot_line.weight_grams côté DB (ou re-fetch la fiche) : une
    //    seule valeur, cohérente avec la saisie -- pas de double-application.
  });
});

test.describe('Lot F2 — dépense publicitaire exige un arrivage (proof 6, mutation-testé)', () => {
  test('depuis la fiche produit, un produit avec plusieurs arrivages candidats impose un choix explicite', async ({ page }) => {
    // seed 2 arrivages reçus pour le même produit -> le select est requis,
    // aucune option préselectionnée -> le bouton Enregistrer reste désactivé
    // tant qu'aucun arrivage n'est choisi.
  });
});
```

- [ ] **Step 2: Run**

Run: `pnpm exec playwright test tests/e2e/lot-f2-purchase-lot-detail.spec.ts --project=chromium`
Expected: PASS locally (chromium only — per project rule, full mobile-profile judgment is CI-only).

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/lot-f2-purchase-lot-detail.spec.ts
git commit -m "phaseF: Lot F2 - tests E2E : responsive 412/390px, file offline, dépense pub sans arrivage impossible"
```

---

### Task 9: Full sanity loop + lexicon/gray-scale/no-regression proofs

- [ ] **Step 1:** Run the full project gate:

```bash
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:rls
pnpm security:acl-baseline:check
$env:VERCEL_ENV='preview'
pnpm build
```

- [ ] **Step 2:** Grep-check no forbidden vocabulary was introduced:

```bash
grep -rn "réconciliation\|COGS\|marge de contribution\|coût de reprise\|coût de retour\|coût de refus" components/purchases components/products lib/finance lib/actions/purchases.ts lib/offline
```
Expected: no matches.

- [ ] **Step 3:** Confirm no tutoiement (reuse the existing anti-tutoiement pattern from `tests/unit/ui/no-tutoiement-finance-components.test.ts` — extend its file globs to include the new `components/purchases/*.tsx` files, or add a sibling test file following the exact same regex approach).

- [ ] **Step 4:** Confirm zero files touched under `app/(app)/finances/**`, `components/finance/**`:

```bash
git diff --stat main... | grep -E "app/\(app\)/finances|components/finance/"
```
Expected: empty output.

- [ ] **Step 5:** Manual/E2E visual check at grayscale (devtools "Emulate vision deficiencies" or a Playwright screenshot with a CSS `filter: grayscale(1)` injected) confirming the `GainLoss` sign (`+`/`−`) and label remain legible without color.

- [ ] **Step 6: Final commit if anything above required a fix, then hand off per the `batch-workflow` skill** (branch → PR → CI → squash merge, per project discipline). Do not push without the developer's confirmation.

---

## Summary of what's deliberately NOT built (per spec's "hors périmètre")

- No comparison between lots, no stagnation alert, no global completeness indicator, no notification.
- No new component in `components/ui/*` — only local, feature-scoped files.
- No Finances file touched.
- No migration beyond the one aggregation RPC.
- No backfill of historical `product_ad_spend`/weights.
