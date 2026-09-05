# UX-CAT-01 — Produits, Stock, Clients, Paramètres Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last horizontally-scrolling mobile table (Stock), fix the false "Valeur totale du stock" figure (`unit_cost ?? 0` + a client-side aggregate truncated at 25 rows), and correct four proven Clients defects (inert button, 50-row cap, selection race, mis-sorted/truncated history) — all backed by the (unmerged) `U0-D2-DIAGNOSTIC-LECTURE-SEULE.md` diagnostic, without inventing any table, column, RPC, or migration.

**Architecture:** Everything ships without a migration. The stock aggregate bug is fixed by a new pure-TS module (`lib/stock/stock-catalog-facts.ts`) that pages through the **entire** shop catalog server-side via the existing `fetchAllPostgrestRows` helper (`lib/supabase/pagination.ts`, already used by `lib/actions/drivers.ts`/`lib/finance/*` for the exact same `max_rows=1000` problem) and computes total value / low-stock count / low-stock id set from one shared predicate, consumed by both the summary banner and the "N produits en stock bas" filter link. The Clients fixes reuse two things that already exist: the `orders.sort_at` generated column (`coalesce(created_at_shopify, created_at)`, migration `0044`, already used by `lib/actions/orders.ts`) for the mis-sorted history, and the order search's existing phone-match filter (`lib/orders/search.ts:73-93`) for "Voir commandes" — so "aucune nouvelle destination de navigation" is respected by reusing the same `/commandes?q=` route with a phone value instead of free text. The numeric client score is removed per the founder's decision (this session); "Demander confirmation" is disabled honestly per the founder's decision (this session).

**Tech Stack:** Next.js App Router server actions (`next-safe-action`), Supabase JS (service-role admin client + RLS client), Vitest (`tests/unit`), Playwright (`tests/e2e`), next-intl (`messages/fr.json`).

## Global Constraints

- Interactive targets stay 48×48 CSS px (reachable zone, not visual box) — inherited from `UX-DS-01`, not redefined here.
- `<Amount>` (`components/ui/amount.tsx`) for every money value. No local formatter (`formatMinorAmount` in `products-catalog.tsx` is exactly the kind of thing to delete).
- Vouvoiement, XOF with no decimals via `formatMoney`, narrow no-break space thousands separator — all already inside `<Amount>`/`formatMoney`, never hand-rolled.
- No new navigation destination. Filters are query params on existing routes (`?tab=stock&filtre=...`, `?q=<phone>`), never a new page.
- Three test widths: 390px, 412px, 1280px.
- No migration, no new table/column/RPC. If a step in this plan seems to need one, stop and flag it rather than inventing it (CLAUDE.md rule #1/#2).
- Consult `docs/lexique-microcopie.md` before writing/reusing any user-facing string (CLAUDE.md rule #13); add an entry when a decision is made here that could otherwise silently drift later.
- Founder decisions already made this session (do not re-litigate): the numeric 0-100 client score is **removed** (keep tier + verifiable facts only); "Demander confirmation" is **disabled honestly** (`disabled` + `title`), like its two `risk`-tier siblings.
- Two-PR split is fixed: **PR1 = Stock + Produits** (Tasks 1-9), **PR2 = Clients + Paramètres** (Tasks 10-17). Do not merge PR2 work into PR1's branch/commits.
- Sanity loop before every commit: `pnpm typecheck && pnpm lint && pnpm vitest run && $env:VERCEL_ENV='preview'; pnpm build`, plus `pnpm test:rls` non-skipped, plus `pnpm security:acl-baseline:check`. Never commit red.
- No test, screenshot, or manual verification against the pilot merchant's real account/shop — dedicated test account + test shop only (CLAUDE.md rule #14).

---

## PR1 — Stock & Produits

Branch: `phaseUX-CAT-01/stock-produits` off the real tip of `main` (`git fetch && git log origin/main -1` first — do not assume the SHA in this plan's header is still current).

### Task 1: `lib/stock/stock-catalog-facts.ts` — one predicate, whole catalog

**Files:**
- Create: `lib/stock/stock-catalog-facts.ts`
- Test: `tests/unit/stock/stock-catalog-facts.test.ts`

**Interfaces:**
- Produces: `type StockCatalogRow = { productId: string; qtyOnHand: number; qtyReserved: number; unitCost: number; lowStockThreshold: number; isBundle: boolean }`
- Produces: `async function fetchStockCatalogRows(admin: SupabaseClient<Database>, merchantAccountId: string, shopId: string): Promise<{ ok: true; rows: StockCatalogRow[] } | { ok: false; message: string }>`
- Produces: `type StockCatalogSummary = { totalValueMinor: number | null; costUnknownCount: number; lowStockCount: number; lowStockProductIds: string[] }`
- Produces: `function computeStockCatalogSummary(rows: StockCatalogRow[]): StockCatalogSummary`
- Produces: `function isStockCostMissing(unitCost: number): boolean` (= `unitCost <= 0`, same convention as `lib/finance/product-cost.ts:34`'s `costMissing`)
- Consumes (Task 2): both functions are called from `getProductsPageData`/a new server function in `lib/actions/products.ts`.

- [ ] **Step 1: Write the failing test for `computeStockCatalogSummary`**

```typescript
// tests/unit/stock/stock-catalog-facts.test.ts
import { describe, expect, it } from 'vitest';
import {
  computeStockCatalogSummary,
  isRowLowStock,
  isStockCostMissing,
  type StockCatalogRow,
} from '@/lib/stock/stock-catalog-facts';

function row(overrides: Partial<StockCatalogRow>): StockCatalogRow {
  return {
    productId: 'p',
    qtyOnHand: 0,
    qtyReserved: 0,
    unitCost: 0,
    lowStockThreshold: 10,
    isBundle: false,
    ...overrides,
  };
}

describe('isStockCostMissing', () => {
  it('treats unit_cost <= 0 as missing, matching lib/finance costMissing convention', () => {
    expect(isStockCostMissing(0)).toBe(true);
    expect(isStockCostMissing(-1)).toBe(true);
    expect(isStockCostMissing(1)).toBe(false);
  });
});

describe('isRowLowStock', () => {
  it('matches the exact formula already used at lib/actions/products.ts:232/:455 (qtyOnHand <= threshold)', () => {
    expect(isRowLowStock(5, 10)).toBe(true);
    expect(isRowLowStock(10, 10)).toBe(true);
    expect(isRowLowStock(11, 10)).toBe(false);
  });
});

describe('computeStockCatalogSummary', () => {
  it('case "zéro réel" : tous les coûts connus, total à zéro', () => {
    const rows = [
      row({ productId: 'a', qtyOnHand: 0, unitCost: 5000 }),
      row({ productId: 'b', qtyOnHand: 0, unitCost: 3000 }),
    ];
    const summary = computeStockCatalogSummary(rows);
    expect(summary.totalValueMinor).toBe(0);
    expect(summary.costUnknownCount).toBe(0);
  });

  it('case "valeur partielle" : un coût manquant, un sous-total réel sur le reste', () => {
    const rows = [
      row({ productId: 'a', qtyOnHand: 10, unitCost: 500 }), // 5000, connu
      row({ productId: 'b', qtyOnHand: 4, unitCost: 0 }), // coût jamais saisi, qty > 0
    ];
    const summary = computeStockCatalogSummary(rows);
    expect(summary.totalValueMinor).toBe(5000);
    expect(summary.costUnknownCount).toBe(1);
  });

  it('case "rien de calculable" : aucun produit avec un coût connu', () => {
    const rows = [row({ productId: 'a', qtyOnHand: 4, unitCost: 0 })];
    const summary = computeStockCatalogSummary(rows);
    expect(summary.totalValueMinor).toBeNull();
    expect(summary.costUnknownCount).toBe(1);
  });

  it('exclut les bundles du total et du compteur de coût manquant', () => {
    const rows = [row({ productId: 'bundle', isBundle: true, qtyOnHand: 0, unitCost: 0 })];
    const summary = computeStockCatalogSummary(rows);
    expect(summary.totalValueMinor).toBeNull();
    expect(summary.costUnknownCount).toBe(0);
  });

  it('le lowStockCount et lowStockProductIds viennent du même prédicat, catalogue > 25 lignes', () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      row({
        productId: `p${i}`,
        qtyOnHand: i < 26 ? 1 : 100, // 26 premières lignes en dessous du seuil 10
        lowStockThreshold: 10,
      }),
    );
    const summary = computeStockCatalogSummary(rows);
    expect(summary.lowStockCount).toBe(26);
    expect(summary.lowStockProductIds).toHaveLength(26);
    expect(new Set(summary.lowStockProductIds).size).toBe(summary.lowStockCount);
  });

  it('un coût manquant à qty=0 ne compte pas comme "coût manquant" (rien à valoriser)', () => {
    const rows = [row({ productId: 'a', qtyOnHand: 0, unitCost: 0 })];
    const summary = computeStockCatalogSummary(rows);
    expect(summary.costUnknownCount).toBe(0);
    expect(summary.totalValueMinor).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/stock/stock-catalog-facts.test.ts`
Expected: FAIL — `Cannot find module '@/lib/stock/stock-catalog-facts'`

- [ ] **Step 3: Implement `lib/stock/stock-catalog-facts.ts`**

```typescript
// lib/stock/stock-catalog-facts.ts
//
// Corrige le P0 U0-D2 "Valeur totale du stock" : deux défauts cumulés dans
// l'ancien calcul client (components/stock/stock-table.tsx avant ce lot) —
// (1) unit_cost ?? 0 confondait "jamais coûté" et "coûté à zéro" (violation
// du contrat "manquant ≠ zéro"), (2) l'agrégat était recalculé côté React
// sur les 25 lignes déjà chargées, jamais sur le catalogue entier.
//
// Fix : une seule lecture serveur, paginée via fetchAllPostgrestRows (même
// mécanisme que lib/actions/drivers.ts pour le même plafond PostgREST
// max_rows=1000), qui nourrit à la fois le total, le compteur "stock bas" et
// la population que l'alerte ouvre — un seul prédicat, jamais trois lectures
// divergentes.
import { fetchAllPostgrestRows } from '@/lib/supabase/pagination';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

export type StockCatalogRow = {
  productId: string;
  qtyOnHand: number;
  qtyReserved: number;
  unitCost: number;
  lowStockThreshold: number;
  isBundle: boolean;
};

export type StockCatalogSummary = {
  // null = rien de calculable (aucun produit non-bundle avec un coût connu et une quantité).
  totalValueMinor: number | null;
  // Produits non-bundle avec qty_on_hand > 0 et un coût jamais saisi (unit_cost <= 0).
  costUnknownCount: number;
  lowStockCount: number;
  lowStockProductIds: string[];
};

// Même convention que lib/finance/product-cost.ts:34 (costMissing = unitCost <= 0) —
// product_stock.unit_cost est `bigint not null default 0`, jamais null : un coût
// jamais saisi et un coût réellement nul partagent la même valeur en base, la
// distinction est purement conventionnelle, déjà tranchée ailleurs dans ce projet.
export function isStockCostMissing(unitCost: number): boolean {
  return unitCost <= 0;
}

// Seule et unique définition de "stock bas" du projet — DOIT rester la formule
// utilisée par lib/actions/products.ts (ProductsPageItem.isLowStock,
// getProductsPageData ET loadMoreProductsAction) pour que le compteur/l'alerte
// de ce module et le badge affiché sur chaque ligne ne divergent jamais.
// Importer cette fonction plutôt que de réécrire `qtyOnHand <= threshold`
// ailleurs — vérifié par grep avant ce lot : les 2 call sites de
// lib/actions/products.ts utilisaient déjà exactement cette expression,
// jamais qtyAvailable ; alignés ici pour que ça reste vrai après ce lot aussi.
export function isRowLowStock(qtyOnHand: number, lowStockThreshold: number): boolean {
  return qtyOnHand <= lowStockThreshold;
}

export function computeStockCatalogSummary(rows: StockCatalogRow[]): StockCatalogSummary {
  const sellable = rows.filter((r) => !r.isBundle);

  let totalValueMinor: number | null = null;
  let costUnknownCount = 0;
  const lowStockProductIds: string[] = [];

  for (const r of sellable) {
    // Règle : qty_on_hand = 0 vaut zéro, quel que soit le coût — rien à
    // valoriser, ce n'est jamais un "coût manquant". Seul un coût manquant
    // AVEC un stock positif rend la valeur non calculable pour cette ligne.
    if (r.qtyOnHand === 0) {
      totalValueMinor = (totalValueMinor ?? 0) + 0;
    } else if (isStockCostMissing(r.unitCost)) {
      costUnknownCount += 1;
    } else {
      totalValueMinor = (totalValueMinor ?? 0) + r.qtyOnHand * r.unitCost;
    }
    if (isRowLowStock(r.qtyOnHand, r.lowStockThreshold)) {
      lowStockProductIds.push(r.productId);
    }
  }

  return {
    totalValueMinor,
    costUnknownCount,
    lowStockCount: lowStockProductIds.length,
    lowStockProductIds,
  };
}

export async function fetchStockCatalogRows(
  admin: SupabaseClient<Database>,
  merchantAccountId: string,
  shopId: string,
): Promise<{ ok: true; rows: StockCatalogRow[] } | { ok: false; message: string }> {
  const { data: products, error: productError } = await fetchAllPostgrestRows((from, to) =>
    admin
      .from('product')
      .select('id, is_bundle')
      .eq('merchant_account_id', merchantAccountId)
      .eq('shop_id', shopId)
      .eq('is_active', true)
      .order('id', { ascending: true })
      .range(from, to),
  );
  if (productError) return { ok: false, message: productError.message };

  const { data: stocks, error: stockError } = await fetchAllPostgrestRows((from, to) =>
    admin
      .from('product_stock')
      .select('product_id, qty_on_hand, qty_reserved, unit_cost, low_stock_threshold')
      .eq('merchant_account_id', merchantAccountId)
      .eq('shop_id', shopId)
      .order('product_id', { ascending: true })
      .range(from, to),
  );
  if (stockError) return { ok: false, message: stockError.message };

  const stockMap = new Map(stocks.map((s) => [s.product_id, s]));

  const rows: StockCatalogRow[] = products.map((p) => {
    const s = stockMap.get(p.id);
    return {
      productId: p.id,
      qtyOnHand: s?.qty_on_hand ?? 0,
      qtyReserved: s?.qty_reserved ?? 0,
      unitCost: s?.unit_cost ?? 0,
      lowStockThreshold: s?.low_stock_threshold ?? 10,
      isBundle: p.is_bundle,
    };
  });

  return { ok: true, rows };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/stock/stock-catalog-facts.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/stock/stock-catalog-facts.ts tests/unit/stock/stock-catalog-facts.test.ts
git commit -m "$(cat <<'EOF'
phaseUX-CAT-01: Stock — prédicat serveur unique (valeur totale, coût manquant, stock bas)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01M5bNPykcAJ6AquidVkpfwQ
EOF
)"
```

---

### Task 2: Wire the summary + low-stock filter into `getProductsPageData`

**Files:**
- Modify: `lib/actions/products.ts` (add `getStockCatalogSummaryData`, extend `getProductsPageData`/`loadMoreProductsAction` with a `lowStockOnly` param)
- Modify: `app/(app)/produits/page.tsx` (compute + pass summary only on `tab === 'stock'`, parse `?filtre=stock_bas`)
- Modify: `components/products/products-page-loader.tsx` (accept `stockSummary`, pass through, wire "Voir plus" to carry `lowStockOnly`)
- Test: `tests/unit/products/products-page-data-stock-summary.test.ts` — skip if it would require mocking the full Supabase client stack already avoided elsewhere for this file (verify by checking whether `lib/actions/products.ts` has existing unit tests first); otherwise cover via the e2e proof in Task 9.

**Interfaces:**
- Consumes: `fetchStockCatalogRows`, `computeStockCatalogSummary`, `isRowLowStock` from Task 1.
- Produces: `export async function getStockCatalogSummaryData(shopId: string): Promise<{ ok: true; summary: StockCatalogSummary } | { ok: false; errorCode: string }>` in `lib/actions/products.ts`.
- Produces: `getProductsPageData(params: { q?: string; offset?: number; shopId: string; lowStockOnly?: boolean; activeOnly?: boolean })` — same return shape as today, plus filters by `.in('id', lowStockProductIds)` when `lowStockOnly` is true, and by `.eq('is_active', true)` when `activeOnly` is true.
- Produces: `loadMoreProductsAction` input schema gains `lowStockOnly: z.boolean().optional()` and `activeOnly: z.boolean().optional()`, threaded the same way.

- [ ] **Step 1: Add `getStockCatalogSummaryData` to `lib/actions/products.ts` — cost hidden for `agent`, quantity facts kept**

Low stock is a **quantity** fact, not a cost fact — masking it entirely for `agent` (as an earlier draft of this task did, returning all-zeros) makes the low-stock alert disappear for that role even though `agent` can otherwise see the Stock tab (`En stock`/`Réservé`/`Disponible`/`Seuil alerte` columns are all quantity, only `Valeur` is cost-gated in `stock-table.tsx`). Compute the real summary for every role, then mask only the cost-derived fields post-hoc:

Add near `getProductCatalogPageData` (after its closing brace, before `createProductAction`):

```typescript
import {
  computeStockCatalogSummary,
  fetchStockCatalogRows,
  type StockCatalogSummary,
} from '@/lib/stock/stock-catalog-facts';

export async function getStockCatalogSummaryData(
  shopId: string,
): Promise<{ ok: true; summary: StockCatalogSummary } | { ok: false; errorCode: string }> {
  const currentMember = await getCurrentMember();
  if (!currentMember.ok) return currentMember;
  const { merchantAccountId, role } = currentMember.member;
  const canSeeCost = role === 'owner' || role === 'manager';

  const admin = createSupabaseAdminClient();
  const result = await fetchStockCatalogRows(admin, merchantAccountId, shopId);
  if (!result.ok) return { ok: false, errorCode: 'load_failed' };

  const summary = computeStockCatalogSummary(result.rows);

  return {
    ok: true,
    summary: canSeeCost
      ? summary
      : {
          // Masqué : dérivé de unit_cost, une donnée de coût (RLS #9).
          totalValueMinor: null,
          costUnknownCount: 0,
          // Conservé : quantité, pas coût — l'agent voit et peut ouvrir la
          // même population "stock bas" que owner/manager.
          lowStockCount: summary.lowStockCount,
          lowStockProductIds: summary.lowStockProductIds,
        },
  };
}
```

- [ ] **Step 2: Add `lowStockOnly` + `activeOnly` filtering to `getProductsPageData` and `loadMoreProductsAction`, and stop reimplementing "low stock"**

`getProductsPageData`/`loadMoreProductsAction` today select `is_active` but never filter on it (verified by grep — no `.eq('is_active', true)` anywhere in `lib/actions/products.ts`), so the Stock tab currently lists inactive products too. `fetchStockCatalogRows` (Task 1) DOES filter `is_active = true`. Left as-is, the summary's population (active only) and the displayed rows (active + inactive) would silently diverge — exactly the divergence class this lot exists to close, recreated inside the same screen. Fix: an `activeOnly` param, applied only for the Stock tab (Task 3 wires it), leaving the Catalogue tab's intentional Actif/Inactif display untouched.

Also replace the inline `isLowStock: qtyOnHand <= threshold` (today at `lib/actions/products.ts:232` and `:455`) with the single predicate from Task 1 — two independent copies of the same expression is exactly how the "which formula does the badge actually use" doubt arose; importing one function removes the doubt structurally instead of by inspection.

```typescript
import {
  computeStockCatalogSummary,
  fetchStockCatalogRows,
  isRowLowStock,
  type StockCatalogSummary,
} from '@/lib/stock/stock-catalog-facts';

export async function getProductsPageData(params: {
  q?: string;
  offset?: number;
  shopId: string;
  lowStockOnly?: boolean;
  activeOnly?: boolean;
}): Promise<ProductsPageResult> {
  const currentMember = await getCurrentMember();
  if (!currentMember.ok) return currentMember;

  const { merchantAccountId, role } = currentMember.member;
  const canSeeCost = role === 'owner' || role === 'manager';
  const offset = params.offset ?? 0;
  const limit = PRODUCTS_PER_PAGE + 1;

  const admin = createSupabaseAdminClient();

  let lowStockIds: string[] | null = null;
  if (params.lowStockOnly) {
    const facts = await fetchStockCatalogRows(admin, merchantAccountId, params.shopId);
    if (!facts.ok) return { ok: false, errorCode: 'load_failed' };
    lowStockIds = computeStockCatalogSummary(facts.rows).lowStockProductIds;
    if (lowStockIds.length === 0) {
      return { ok: true, items: [], hasMore: false, nextOffset: 0, canSeeCost, currentRole: role };
    }
  }

  let productQuery = admin
    .from('product')
    .select(
      'id, title, sku, unit_cost, is_active, shopify_product_id, shopify_variant_id, created_at, updated_at, is_bundle',
    )
    .eq('merchant_account_id', merchantAccountId)
    .eq('shop_id', params.shopId)
    .order('title', { ascending: true })
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1);

  if (params.activeOnly) {
    productQuery = productQuery.eq('is_active', true);
  }

  if (lowStockIds) {
    productQuery = productQuery.in('id', lowStockIds);
  }

  if (params.q?.trim()) {
    const q = params.q.trim();
    productQuery = productQuery.or(`title.ilike.%${q}%,sku.ilike.%${q}%`);
  }

  // ... rest unchanged down to the items.map(...) block, where:
  //   isLowStock: qtyOnHand <= threshold,
  // becomes:
  //   isLowStock: isRowLowStock(qtyOnHand, threshold),
```

Apply the identical `activeOnly`/`lowStockIds`/`.in()`/`isRowLowStock` changes to `loadMoreProductsAction`'s input schema (`lowStockOnly: z.boolean().optional()`, `activeOnly: z.boolean().optional()`) and query construction, mirroring the same lines (its query block is structurally identical, lines 392-406/455 today).

- [ ] **Step 3: Wire the route (`app/(app)/produits/page.tsx`) — `activeOnly` scoped to the Stock tab only**

`activeOnly` is `tab === 'stock'`, never applied to the Catalogue tab (which intentionally shows inactive products with an "Inactif" badge, `products-catalog.tsx` — unaffected by this lot):

```typescript
const rawFiltre = typeof params.filtre === 'string' ? params.filtre : '';
const activeOnly = tab === 'stock';
const lowStockOnly = tab === 'stock' && rawFiltre === 'stock_bas';

const [productsResult, stockSummaryResult] = await Promise.all([
  getProductsPageData({ q: q.trim() || undefined, shopId: storeId, activeOnly, lowStockOnly }),
  tab === 'stock' ? getStockCatalogSummaryData(storeId) : Promise.resolve(null),
]);
```

Pass `stockSummary={stockSummaryResult?.ok ? stockSummaryResult.summary : null}` and `lowStockOnly={lowStockOnly}` to `<ProductsPageLoader>`. Import `getStockCatalogSummaryData` from `@/lib/actions/products`.

- [ ] **Step 4: Thread through `ProductsPageLoader`**

Add `stockSummary: StockCatalogSummary | null` and `lowStockOnly: boolean` to `Props`; pass both to `<StockTable>` (replacing the client-computed `lowStockCount`/`totalValue` — see Task 4); when calling `loadMoreProductsAction`, add `lowStockOnly: view === 'stock' ? lowStockOnly : undefined` and `activeOnly: view === 'stock'` to the payload so "Voir plus" keeps both the active-only scope and the low-stock filter consistent with the initial load.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no new errors)

- [ ] **Step 6: Commit**

```bash
git add lib/actions/products.ts app/\(app\)/produits/page.tsx components/products/products-page-loader.tsx
git commit -m "$(cat <<'EOF'
phaseUX-CAT-01: Stock — agrégat serveur + filtre stock bas (même prédicat)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01M5bNPykcAJ6AquidVkpfwQ
EOF
)"
```

---

### Task 3: `docs/lexique-microcopie.md` — record the "coût manquant" reuse

**Files:**
- Modify: `docs/lexique-microcopie.md`

- [ ] **Step 1: Add an entry to "Formulations figées"**

```markdown
| « Coût manquant » | **Réutilisée verbatim** depuis `finance.products.table.costMissing` (Lot F2-bis) pour la carte "Valeur totale du stock" (`/produits?tab=stock`). | Même contrat "manquant ≠ zéro" (`unit_cost <= 0` = jamais saisi), même écran de risque (un chiffre faux affiché avec la confiance d'un total exact) — pas de raison de reformuler. Lot UX-CAT-01. |
```

- [ ] **Step 2: Commit**

```bash
git add docs/lexique-microcopie.md
git commit -m "$(cat <<'EOF'
phaseUX-CAT-01: doc — lexique, réutilisation « Coût manquant » sur Stock

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01M5bNPykcAJ6AquidVkpfwQ
EOF
)"
```

---

### Task 4: `StockTable` — three value cases, clickable alert, labels, deficit display

**Files:**
- Modify: `components/stock/stock-table.tsx`

**Interfaces:**
- Consumes: `StockCatalogSummary` (Task 1), `stockSummary`/`lowStockOnly`/`storeId` props threaded from Task 2.

- [ ] **Step 1: Change `Props` and delete client-side aggregation**

```typescript
type Props = {
  rows: StockPageRow[];
  canSeeCost: boolean;
  stockSummary: StockCatalogSummary | null;
  lowStockOnly: boolean;
  storeId: string;
};
```

Delete the two `const lowStockCount = ...` / `const totalValue = ...` lines (351-323 today) — they read `stockSummary` instead.

- [ ] **Step 2: Render the three value cases + clickable alert**

Replace the current alert + "Valeur totale du stock" block with:

```tsx
{stockSummary && stockSummary.lowStockCount > 0 && (
  <Link
    className="flex min-h-12 items-center gap-3 rounded-lg border border-danger/25 bg-danger-subtle p-4 text-sm font-medium text-danger hover:bg-danger-subtle/80"
    href={`/s/${storeId}/produits?tab=stock&filtre=stock_bas`}
  >
    <span>
      {stockSummary.lowStockCount} produit{stockSummary.lowStockCount > 1 ? 's' : ''} en stock bas
    </span>
  </Link>
)}

{lowStockOnly && (
  <Link
    className="inline-flex min-h-12 items-center text-sm font-medium text-muted underline underline-offset-2 hover:text-text"
    href="/s/${storeId}/produits?tab=stock"
  >
    Retirer le filtre « stock bas »
  </Link>
)}

{canSeeCost && stockSummary && (
  <p className="text-sm text-muted">
    Valeur totale du stock :{' '}
    {stockSummary.totalValueMinor !== null ? (
      <Amount amountMinor={stockSummary.totalValueMinor} className="font-semibold text-text" />
    ) : (
      <span className="font-semibold text-text">Non calculable</span>
    )}
    {stockSummary.costUnknownCount > 0 && (
      <span className="ml-1 text-muted">
        — {stockSummary.costUnknownCount} coût{stockSummary.costUnknownCount > 1 ? 's' : ''} manquant
        {stockSummary.costUnknownCount > 1 ? 's' : ''}
      </span>
    )}
  </p>
)}
```

(Use a real `<Link>` from `next/link`, imported at the top of the file, and interpolate `storeId` correctly with a template literal — the snippet above is illustrative, fix the literal `${storeId}` in the "retirer le filtre" href to an actual template string.)

- [ ] **Step 3: Relabel "Commandé" → "Réservé"**

```tsx
<th className="px-4 py-3 font-medium text-right">Réservé</th>
```

(was `Commandé`, `components/stock/stock-table.tsx:357` today — `qty_reserved` is a reservation, not a customer order, per U0-D2 §5.)

- [ ] **Step 4: Signed, labeled, colored deficit for negative bundle availability**

Replace the bundle availability cell:

```tsx
<td
  className={cn(
    'px-4 py-3 text-right font-mono tabular-nums',
    row.bundleAvailability !== null && row.bundleAvailability < 0 && 'text-danger font-semibold',
  )}
  title="Disponibilité dérivée du stock de ses composants (min de stock_composant / quantité requise)"
>
  {row.bundleAvailability === null
    ? '—'
    : row.bundleAvailability < 0
      ? `Déficit : ${row.bundleAvailability}`
      : row.bundleAvailability}
</td>
```

(The negative value itself — `computeBundleDerivedAvailability`, `lib/products/bundle-availability.ts` — is intentional per its own doc comment and is NOT to be floored or changed; only its presentation gains a sign, a label, and a color.)

- [ ] **Step 5: Typecheck + run existing bundle-availability unit test unaffected**

Run: `pnpm typecheck && pnpm vitest run tests/unit/products/bundle-availability.test.ts`
Expected: PASS (formula untouched, only presentation changed)

- [ ] **Step 6: Commit**

```bash
git add components/stock/stock-table.tsx
git commit -m "$(cat <<'EOF'
phaseUX-CAT-01: Stock — 3 cas de valeur, alerte cliquable, libellé Réservé, déficit bundle visible

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01M5bNPykcAJ6AquidVkpfwQ
EOF
)"
```

---

### Task 5: `StockTable` — mobile card layout

**Files:**
- Modify: `components/stock/stock-table.tsx`

**Interfaces:**
- Consumes: `StockPageRow[]` (unchanged type).

- [ ] **Step 1: Wrap the existing `<table>` in `hidden md:block`, matching `components/drivers/driver-stock-table.tsx:185-231`'s established desktop/mobile split**

```tsx
<div className="hidden overflow-x-auto rounded-lg border border-border md:block">
  <table className="w-full text-sm">{/* unchanged table markup from Task 4 */}</table>
</div>
```

- [ ] **Step 2: Add a `md:hidden` card list below it, one `<article>` per row, reusing the same per-row state (`activeForm`, `menuOpen`, `thresholdEdit`) already declared in `StockTable`**

```tsx
<div className="space-y-3 md:hidden">
  {rows.map((row) => {
    const isEditingThreshold = thresholdEdit === row.productId;
    const form =
      activeForm !== null && activeForm.productId === row.productId ? activeForm.type : null;

    return (
      <article
        className="space-y-3 rounded-lg border border-border bg-surface p-4 shadow-1"
        key={row.productId}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-medium">{row.title}</p>
            {row.sku && <p className="text-xs text-muted">{row.sku}</p>}
          </div>
          <div className="flex flex-wrap justify-end gap-1">
            {row.isBundle && <BundleBadge />}
            {!row.isBundle && row.isLowStock && <LowStockBadge />}
          </div>
        </div>

        {row.isBundle ? (
          <p
            className={cn(
              'font-mono text-sm',
              row.bundleAvailability !== null && row.bundleAvailability < 0 && 'text-danger font-semibold',
            )}
          >
            Disponible :{' '}
            {row.bundleAvailability === null
              ? '— (composition incomplète)'
              : row.bundleAvailability < 0
                ? `Déficit : ${row.bundleAvailability}`
                : row.bundleAvailability}
          </p>
        ) : (
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <dt className="text-xs text-muted">En stock</dt>
              <dd className="font-mono">{row.qtyOnHand}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Réservé</dt>
              <dd className="font-mono text-muted">{row.qtyReserved}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Disponible</dt>
              <dd className={cn('font-mono', row.isLowStock && 'text-danger font-semibold')}>
                {row.qtyAvailable}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Seuil alerte</dt>
              <dd>
                {isEditingThreshold ? (
                  <ThresholdForm
                    current={row.lowStockThreshold}
                    onDone={() => setThresholdEdit(null)}
                    productId={row.productId}
                  />
                ) : (
                  <button
                    className="min-h-12 text-muted underline underline-offset-2 hover:text-text"
                    onClick={() => setThresholdEdit(row.productId)}
                    type="button"
                  >
                    {row.lowStockThreshold}
                  </button>
                )}
              </dd>
            </div>
            {canSeeCost && (
              <div className="col-span-2">
                <dt className="text-xs text-muted">Valeur</dt>
                <dd>{row.stockValue !== null ? <Amount amountMinor={row.stockValue} /> : '—'}</dd>
              </div>
            )}
          </dl>
        )}

        {!row.isBundle && (
          <div className="space-y-2">
            {!form && menuOpen !== row.productId && (
              <button
                className="min-h-12 w-full rounded-md border border-border bg-canvas px-3 text-sm font-medium hover:bg-surface"
                onClick={() => setMenuOpen(row.productId)}
                type="button"
              >
                Modifier le stock
              </button>
            )}
            {!form && menuOpen === row.productId && (
              <div className="flex flex-wrap gap-2">
                <button
                  className="min-h-12 rounded-md border border-border bg-canvas px-3 text-sm font-medium hover:bg-surface"
                  onClick={() => openForm('purchase', row.productId)}
                  type="button"
                >
                  + Entrée stock
                </button>
                <button
                  className="min-h-12 rounded-md border border-border bg-canvas px-3 text-sm font-medium hover:bg-surface"
                  onClick={() => openForm('adjustment', row.productId)}
                  type="button"
                >
                  Ajustement
                </button>
                <button
                  className="min-h-12 rounded-md border border-border bg-canvas px-3 text-sm font-medium hover:bg-surface"
                  onClick={() => openForm('return', row.productId)}
                  type="button"
                >
                  Retour livreur
                </button>
                <button
                  className="min-h-12 rounded-md px-3 text-sm text-muted underline"
                  onClick={() => setMenuOpen(null)}
                  type="button"
                >
                  Annuler
                </button>
              </div>
            )}
            {form === 'purchase' && <PurchaseForm onDone={closeForm} productId={row.productId} />}
            {form === 'adjustment' && <AdjustmentForm onDone={closeForm} productId={row.productId} />}
            {form === 'return' && <CourierReturnForm onDone={closeForm} productId={row.productId} />}
          </div>
        )}
      </article>
    );
  })}
</div>
```

- [ ] **Step 2: Manual check at 390/412/1280px**

Run the app (`pnpm dev`, against a dedicated test shop — see Task 9's proof section) and verify at each width: no horizontal scroll, no truncated amount, product identity never lost, low-stock alert opens the filtered view, bundle deficit shows sign+label+color.

- [ ] **Step 3: Commit**

```bash
git add components/stock/stock-table.tsx
git commit -m "$(cat <<'EOF'
phaseUX-CAT-01: Stock — carte mobile par produit (dernier tableau à défilement horizontal fermé)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01M5bNPykcAJ6AquidVkpfwQ
EOF
)"
```

---

### Task 6: Delete dead code — `getStockPageData`

**Files:**
- Modify: `lib/actions/stock.ts`

- [ ] **Step 1: Confirm zero callers (already verified during planning, re-verify before deleting)**

Run: `grep -rn "getStockPageData" --include='*.ts' --include='*.tsx' .`
Expected: only the definition site in `lib/actions/stock.ts`.

- [ ] **Step 2: Delete `getStockPageData` and the now-unused `StockPageData` type**

Remove lines 285-362 of `lib/actions/stock.ts` (the `StockPageData` type and `getStockPageData` function). Keep `StockPageRow` (still consumed by `stock-table.tsx` and `products-page-loader.tsx`'s `toStockRow`). Remove now-unused imports if `resolveBundleAvailabilities`/`createSupabaseServerClient`/`getRequestStoreId` become unused in this file after deletion — check with `pnpm lint` in Step 3.

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add lib/actions/stock.ts
git commit -m "$(cat <<'EOF'
phaseUX-CAT-01: Stock — supprime getStockPageData (code mort, dupliquait getProductsPageData)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01M5bNPykcAJ6AquidVkpfwQ
EOF
)"
```

---

### Task 7: Produits catalogue — `<Amount>` instead of "XOF", mobile row tap-to-open + 2-line title

**Files:**
- Modify: `components/products/products-catalog.tsx`
- Modify: `components/ui/resource-row.tsx` (minimal, backward-compatible extension)

**Interfaces:**
- Consumes: `Amount` (`components/ui/amount.tsx`).
- Produces: `ResourceRowProps` gains an optional `titleLineClamp?: 1 | 2` (default `1`, preserves every existing call site's behavior).

- [ ] **Step 1: Extend `ResourceRow` with an optional 2-line title clamp**

```typescript
// components/ui/resource-row.tsx
type ResourceRowBase = {
  leading?: React.ReactNode;
  title: React.ReactNode;
  // Par défaut 1 (troncature simple, comportement historique). Passer 2 pour un
  // titre potentiellement long dont la troncature à 1 ligne rend deux variantes
  // à préfixe commun indistinguables (Produits/UX-CAT-01).
  titleLineClamp?: 1 | 2;
  meta?: React.ReactNode;
  status?: React.ReactNode;
  primaryAction?: React.ReactNode;
  overflow?: React.ReactNode;
  className?: string;
  testId?: string;
};
```

In the component body, change the title span:

```tsx
<span
  className={cn(
    'block font-medium',
    titleLineClamp === 2 ? 'line-clamp-2' : 'truncate',
  )}
>
  {title}
</span>
```

Destructure `titleLineClamp = 1` from props.

- [ ] **Step 2: Verify no existing call site regresses**

Run: `grep -rln "ResourceRow" components/ | xargs grep -L "titleLineClamp"` — every other call site omits the prop and keeps `truncate` (unchanged).
Run: `pnpm vitest run` (any snapshot/unit test touching ResourceRow, if present) — expect PASS.

- [ ] **Step 3: Fix the two "XOF" occurrences in `products-catalog.tsx`**

Delete `formatMinorAmount` (lines 22-27) and its two call sites:

```tsx
// was: <p className="mt-3 text-sm text-muted">Valeur enregistrée : {formatMinorAmount(product.unit_cost)} XOF</p>
{canManage && product.unit_cost !== null ? (
  <p className="mt-3 text-sm text-muted">
    Valeur enregistrée : <Amount amountMinor={product.unit_cost} />
  </p>
) : null}
```

```tsx
// was: metaParts.push(`${formatMinorAmount(product.unit_cost ?? 0)} XOF`);
```

`ClientMeta`/mobile row builds `metaParts` as plain strings (joined with `·`) — since `<Amount>` renders a `<span>`, not a string, this specific call site can't just interpolate it into the joined string. Change `ProductMobileRow`'s meta rendering to a `ReactNode` array instead of a joined string:

```tsx
const metaParts: React.ReactNode[] = [product.sku ?? 'SKU non renseigné'];
if (canManage) {
  metaParts.push(<Amount amountMinor={product.unit_cost ?? 0} key="unit-cost" />);
}
if (product.isBundle) {
  metaParts.push('Bundle');
}
```

Then pass to `ResourceRow`'s `meta` prop as an interleaved fragment:

```tsx
meta={
  <>
    {metaParts.map((part, i) => (
      <span key={i}>
        {i > 0 ? ' · ' : null}
        {part}
      </span>
    ))}
  </>
}
```

Import `Amount` from `@/components/ui/amount` at the top of `products-catalog.tsx`.

- [ ] **Step 4: Whole card opens detail on mobile; 2-line title**

```tsx
<ResourceRow
  meta={/* from Step 3 */}
  onActivate={canManage ? onOpenDetail : undefined}
  overflow={
    canManage ? (
      <ActionSheet
        align="end"
        items={[{ key: 'edit-cost', label: 'Modifier le coût', icon: <Tag className="size-4" />, onSelect: () => onToggleEdit(product.id) }]}
        title={product.title}
        trigger={/* unchanged trigger button */}
      />
    ) : null
  }
  status={/* unchanged */}
  testId={`product-catalog-row-${product.id}`}
  title={<h2 className="text-base font-semibold text-text">{product.title}</h2>}
  titleLineClamp={2}
/>
```

(Remove the `'details'` entry from `overflowItems` — tapping the row now opens detail directly, per spec: "le menu `…` est réservé aux actions rares".)

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add components/ui/resource-row.tsx components/products/products-catalog.tsx
git commit -m "$(cat <<'EOF'
phaseUX-CAT-01: Produits — Amount au lieu de XOF, carte mobile tap-to-open, titre 2 lignes

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01M5bNPykcAJ6AquidVkpfwQ
EOF
)"
```

---

### Task 8: P2 label fix — "Commandé" already renamed in Task 4; verify no other occurrence

**Files:**
- none expected — verification only

- [ ] **Step 1: Grep for any remaining "Commandé" mislabel referring to `qty_reserved`**

Run: `grep -rn "Commandé" components/stock/ components/products/`
Expected: no match (Task 4 already renamed the sole occurrence). If a match remains, fix it now with the same "Réservé" label.

---

### Task 9: PR1 sanity loop, e2e proof, open PR

**Files:**
- Modify: `tests/e2e/products.spec.ts` (extend, do not create a new spec file)

- [ ] **Step 1: Add an e2e case proving the single-predicate property on >25 active products**

Add to `tests/e2e/products.spec.ts`, reusing its existing `adminClient()`/seeding helpers:

```typescript
test('Stock — le total, le compteur d\'alerte et la population ouverte viennent du même prédicat', async ({ page }) => {
  test.skip(!hasSupabaseAdmin, 'Nécessite SUPABASE_SERVICE_ROLE_KEY (stack local).');
  // Seed 30 produits actifs, dont 26 sous leur seuil d'alerte et 2 avec un
  // unit_cost jamais saisi (0) mais une quantité > 0 — reproduit exactement le
  // gabarit prouvé côté unitaire dans stock-catalog-facts.test.ts, mais lu par
  // la vraie page pour prouver le câblage bout en bout, pas seulement la formule.
  // ... seeding via adminClient(), following this file's existing seeding pattern ...

  await page.goto(`/s/${storeId}/produits?tab=stock`);
  const alertText = await page.getByText(/produits? en stock bas/).textContent();
  const alertCount = Number(alertText?.match(/^(\d+)/)?.[1]);

  await page.getByText(/produits? en stock bas/).click();
  await expect(page).toHaveURL(/filtre=stock_bas/);
  const rows = page.getByTestId(/product-catalog-row-|stock-row-/);
  await expect(rows).toHaveCount(alertCount);

  await expect(page.getByText('coût(s) manquant', { exact: false })).toBeVisible();
  await expect(page.getByText('Non calculable')).not.toBeVisible(); // il existe des lignes valorisables
});

test('Stock — un agent voit l\'alerte stock bas mais jamais la valeur (coût masqué, quantité conservée)', async ({ page }) => {
  test.skip(!hasSupabaseAdmin, 'Nécessite SUPABASE_SERVICE_ROLE_KEY (stack local).');
  // Se connecter avec un compte de test au rôle `agent` sur la même boutique de test seedée ci-dessus.
  await page.goto(`/s/${storeId}/produits?tab=stock`);
  await expect(page.getByText(/produits? en stock bas/)).toBeVisible();
  await expect(page.getByText('Valeur totale du stock')).not.toBeVisible();
});
```

(Fill in the seeding block using this file's existing helper conventions — `adminClient()` is already defined at the top of `products.spec.ts`; match its existing product-seeding calls rather than inventing a new helper.)

- [ ] **Step 2: Run the full sanity loop**

```bash
pnpm typecheck
pnpm lint
pnpm vitest run
$env:VERCEL_ENV='preview'; pnpm build
pnpm test:rls
pnpm security:acl-baseline:check
```

Expected: all green. Do NOT run `pnpm test:e2e` locally beyond the one new/targeted spec (CLAUDE.md: local E2E beyond a few dozen tests is not reliable — only GitHub CI's 3-target run is authoritative). Run just the new case locally for a quick sanity check:

`pnpm exec playwright test tests/e2e/products.spec.ts -g "même prédicat" --project=chromium`

- [ ] **Step 3: `git diff --stat main..HEAD`, then open PR1**

Follow the `batch-workflow` skill for the branch→PR→CI→squash-merge discipline. Two distinct workflow runs are required (close/reopen, not re-run/empty commit/`workflow_dispatch` — see plan header's CI note); record both run ids and tree SHAs in the PR report.

PR report must include: the three value cases and their on-screen distinction; proof that the alert count and the opened population match (from Step 1's e2e case); the three widths checked; keyboard pass; per-baseline diff if any visual baseline was regenerated; what remains open (e.g. the "getFinanceChartsAction pagination"/"arrivage legacy shop guard" items from U0-D2 are explicitly out of scope here).

---

## PR2 — Clients & Paramètres

Branch: `phaseUX-CAT-01/clients-parametres` off the same up-to-date `main` tip (re-verify after PR1 merges).

### Task 10: Map `delivered_count`, remove the numeric score

**Files:**
- Modify: `lib/actions/customers.ts`
- Modify: `components/clients/clients-workspace.tsx`
- Modify: `messages/fr.json`

**Interfaces:**
- Produces: `CustomerListItem.deliveredCount: number` (from `row.delivered_count`, already returned by `list_store_customer_reliability`/`get_store_customer_reliability`, migration `0132:828` — no RPC/migration change).

- [ ] **Step 1: Map the field (already returned by the RPC, just unused)**

```typescript
// lib/actions/customers.ts
export type CustomerListItem = {
  cancelledCount: number;
  customerId: string;
  decided: number;
  deliveredCount: number; // NEW
  deliveredLifetime: number;
  fullName: string | null;
  isProvisional: boolean;
  isRecurring: boolean;
  isRefuser: boolean;
  orderCount: number;
  phone: string | null;
  refusedCount: number;
  score: number; // kept in the type (still returned by the RPC) — just not rendered anymore
  tier: ReliabilityTier;
};

function toListItem(row: CustomerReliabilityRow): CustomerListItem {
  return {
    cancelledCount: row.cancelled_count,
    customerId: row.customer_id,
    decided: row.decided,
    deliveredCount: row.delivered_count, // NEW
    deliveredLifetime: row.delivered_lifetime,
    fullName: row.full_name ?? null,
    isProvisional: row.is_provisional,
    isRecurring: isRecurringCustomer(row.order_count),
    isRefuser: isRefuserCustomer(row.refused_count),
    orderCount: row.order_count,
    phone: row.phone ?? null,
    refusedCount: row.refused_count,
    score: row.score,
    tier: toTier(row.tier),
  };
}
```

- [ ] **Step 2: Remove `ScoreValue` from the sheet header; add `deliveredCount` fact tile**

In `clients-workspace.tsx`, delete the `ScoreValue` component (lines 108-116) and its call site in `CustomerSheet`'s header (the `<div className="text-right">…</div>` block at lines 410-415) — the header keeps only `TierBadge` + advice text, no numeric right-hand column.

Change the 4-tile stats grid (lines 506-536) to a 5-tile grid, adding delivered count next to delivered amount:

```tsx
<section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
  <div className="rounded-lg border border-border p-3">
    <p className="text-xs text-muted">{t('stats.orders')}</p>
    <p className="font-mono text-lg font-semibold tabular-nums">{customer.orderCount}</p>
  </div>
  <div className="rounded-lg border border-border p-3">
    <p className="text-xs text-muted">{t('stats.deliveredCount')}</p>
    <p className="font-mono text-lg font-semibold tabular-nums">{customer.deliveredCount}</p>
  </div>
  <div className="rounded-lg border border-border p-3">
    <p className="text-xs text-muted">{t('stats.refused')}</p>
    <p className={cn('font-mono text-lg font-semibold tabular-nums', customer.isRefuser ? 'text-danger' : undefined)}>
      {customer.refusedCount}
    </p>
  </div>
  <div className="rounded-lg border border-border p-3">
    <p className="text-xs text-muted">{t('stats.cancelled')}</p>
    <p className="font-mono text-lg font-semibold tabular-nums">{customer.cancelledCount}</p>
  </div>
  <div className="rounded-lg border border-border p-3">
    <p className="text-xs text-muted">{t('stats.delivered')}</p>
    <p className="text-sm font-semibold">
      <Amount amountMinor={customer.deliveredLifetime} className="font-mono" />
    </p>
  </div>
</section>
```

- [ ] **Step 3: `messages/fr.json` — add `stats.deliveredCount`, leave `score.*`/`list.score` keys as-is if referenced elsewhere**

Run: `grep -rn "clients\.score\.\|t('score\." components/ lib/` to confirm whether `score.hidden`/`score.label` become fully orphaned. `score.provisional` stays in use (still shown for provisional tiers via `TierBadge`'s `title`). If `score.hidden`/`score.label` become orphaned, remove them from `messages/fr.json` (dead i18n keys are noise); otherwise leave them.

Add:

```json
"stats": {
  "orders": "Commandes",
  "deliveredCount": "Livrées",
  "cancelled": "Annulations",
  "delivered": "Montant livré",
  "refused": "Refus"
}
```

(Renamed `stats.delivered` label from "Livré" to "Montant livré" to disambiguate from the new "Livrées" count tile — verify against `docs/lexique-microcopie.md` first; if this reads as a new formulation decision, add an entry there too.)

- [ ] **Step 4: Document the missing "date de dernière commande" — no code change**

Add to the PR2 report (Task 17): the RPC and the screen have no per-customer last-order-date field; this is a genuine data gap (U0-D2 §6/§10 question 2), not implemented here per "signale-le, ne l'invente pas".

- [ ] **Step 5: Typecheck + lint + unit tests**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run tests/unit/customers/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/actions/customers.ts components/clients/clients-workspace.tsx messages/fr.json
git commit -m "$(cat <<'EOF'
phaseUX-CAT-01: Clients — retire le score chiffré, ajoute le fait "commandes livrées" (arbitrage fondateur)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01M5bNPykcAJ6AquidVkpfwQ
EOF
)"
```

---

### Task 11: Disable "Demander confirmation" honestly

**Files:**
- Modify: `components/clients/clients-workspace.tsx`
- Modify: `messages/fr.json`

- [ ] **Step 1: Add the i18n key**

```json
"actions": {
  "title": "Actions",
  "call": "Appeler",
  "whatsapp": "WhatsApp",
  "orders": "Voir commandes",
  "more": "Plus d'actions",
  "requestConfirmation": "Demander confirmation",
  "requestConfirmationSoon": "Disponible bientôt",
  "deposit": "Demander un acompte",
  "depositSoon": "Disponible bientôt",
  "addNote": "Ajouter une note",
  "noteSoon": "Disponible bientôt"
}
```

- [ ] **Step 2: Match the `risk`-tier siblings' pattern exactly**

```tsx
{customer.tier === 'watch' ? (
  <Button
    className="min-h-12"
    disabled
    title={t('actions.requestConfirmationSoon')}
    type="button"
    variant="secondary"
  >
    {t('actions.requestConfirmation')}
  </Button>
) : null}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add components/clients/clients-workspace.tsx messages/fr.json
git commit -m "$(cat <<'EOF'
phaseUX-CAT-01: Clients — désactive honnêtement "Demander confirmation" (arbitrage fondateur)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01M5bNPykcAJ6AquidVkpfwQ
EOF
)"
```

---

### Task 12: Pagination — consume the RPC's existing 100-row/offset capacity

**Files:**
- Modify: `components/clients/clients-workspace.tsx`

**Interfaces:**
- Consumes: `listCustomersAction` (unchanged signature — `limit`/`offset` already accepted, `limit` max already 100 per `listCustomersSchema`).

- [ ] **Step 1: Write the failing test (component-level, if a testing setup for this component exists — otherwise cover via e2e in Task 17; check first)**

Run: `find . -iname "*clients-workspace*test*"` — if none exists, skip straight to implementation and rely on the e2e proof in Task 17 (matches this codebase's existing test distribution, where `clients.spec.ts` e2e is the primary coverage for this component).

- [ ] **Step 2: Add offset-accumulating pagination state**

```typescript
const PAGE_SIZE = 100; // consomme le plafond déjà supporté par listCustomersSchema

export function ClientsWorkspace({ storeId }: { storeId: string }) {
  // ...
  const [customers, setCustomers] = useState<CustomerListItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  useEffect(() => {
    setOffset(0);
    const timeoutId = window.setTimeout(async () => {
      const result = await listCustomers.executeAsync({
        search,
        shopId: storeId,
        sortByRisk,
        limit: PAGE_SIZE,
        offset: 0,
      });
      if (result?.data?.ok) {
        setCustomers(result.data.customers);
        setHasMore(result.data.customers.length === PAGE_SIZE);
      }
    }, 280);

    return () => window.clearTimeout(timeoutId);
  }, [listCustomers.executeAsync, search, sortByRisk, storeId]);

  async function loadMore() {
    const nextOffset = offset + PAGE_SIZE;
    setIsLoadingMore(true);
    const result = await listCustomers.executeAsync({
      search,
      shopId: storeId,
      sortByRisk,
      limit: PAGE_SIZE,
      offset: nextOffset,
    });
    setIsLoadingMore(false);
    if (result?.data?.ok) {
      setCustomers((prev) => [...prev, ...result.data.customers]);
      setHasMore(result.data.customers.length === PAGE_SIZE);
      setOffset(nextOffset);
    }
  }
```

Remove the old `listData`/`customers = listData?.customers ?? []` derivation (now `customers` is its own state, populated by the effect/`loadMore` above) and adjust `loading`/`empty` to read `listCustomers.isExecuting && customers.length === 0` for the initial load only.

- [ ] **Step 3: "Voir plus" button, matching `components/products/products-page-loader.tsx`'s existing pattern**

```tsx
{hasMore && (
  <div className="flex justify-center">
    <button
      className="min-h-12 rounded-lg border border-border bg-surface px-6 text-sm font-medium text-text hover:bg-canvas disabled:opacity-60"
      disabled={isLoadingMore}
      onClick={loadMore}
      type="button"
    >
      {isLoadingMore ? 'Chargement…' : 'Voir plus'}
    </button>
  </div>
)}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add components/clients/clients-workspace.tsx
git commit -m "$(cat <<'EOF'
phaseUX-CAT-01: Clients — pagination "Voir plus" (consomme le plafond RPC déjà supporté, 50→100+)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01M5bNPykcAJ6AquidVkpfwQ
EOF
)"
```

---

### Task 13: Fix the selection race condition

**Files:**
- Modify: `components/clients/clients-workspace.tsx`
- Test: `tests/e2e/clients.spec.ts` (extend)

- [ ] **Step 1: Add a generation-counter guard to `selectCustomer`**

```typescript
const selectionRequestIdRef = useRef(0);

async function selectCustomer(customerId: string) {
  const requestId = ++selectionRequestIdRef.current;
  setSelectedCustomerId(customerId);
  setSelectedCustomer(null);
  setDetailLoading(true);
  setFeedback(null);

  const result = await getCustomer.executeAsync({ customerId, shopId: storeId });

  if (selectionRequestIdRef.current !== requestId) {
    // Une sélection plus récente a déjà démarré — cette réponse est obsolète,
    // ne jamais l'appliquer (course U0-D2 §7/§8).
    return;
  }

  setDetailLoading(false);

  if (result?.data?.ok) {
    setSelectedCustomer(result.data.customer);
    return;
  }

  setFeedback({ tone: 'error', message: t('errors.detail') });
}
```

Import `useRef` from `react` (already imports `useEffect, useMemo, useState` — add `useRef`).

- [ ] **Step 2: Write the red→green e2e proof (extend `tests/e2e/clients.spec.ts`)**

```typescript
test('sélection rapide A puis B — B ne peut pas afficher les données de A', async ({ page }) => {
  test.skip(!hasSupabaseAdmin, 'Nécessite SUPABASE_SERVICE_ROLE_KEY (stack local).');
  // Seed deux clients A et B avec des noms distincts, A avec une réponse
  // artificiellement ralentie (route interception sur l'action getCustomer
  // pour A uniquement) pour forcer l'ordre de résolution B avant A.
  await page.route('**/*', async (route) => {
    // ... délai ciblé sur l'appel réseau de getCustomerAction pour le client A ...
    await route.continue();
  });

  await page.goto(`/s/${storeId}/clients`);
  await page.getByText(customerAName).click();
  await page.getByText(customerBName).click();

  await expect(page.getByRole('heading', { name: customerBName })).toBeVisible();
  await expect(page.getByRole('heading', { name: customerAName })).not.toBeVisible();
});
```

(Fill in the route-delay mechanism using this file's existing Playwright network-interception conventions — check `tests/e2e/orders-search-scroll.spec.ts` or similar for the project's established `page.route()` delay pattern before inventing one.)

- [ ] **Step 3: Run it before the fix (confirm red), then after (confirm green)**

Run: `pnpm exec playwright test tests/e2e/clients.spec.ts -g "sélection rapide" --project=chromium`
Expected: FAIL before Step 1's guard is in place, PASS after. (If already implemented before running, temporarily `git stash` the Step 1 change to capture the red baseline, then restore.)

- [ ] **Step 4: Commit**

```bash
git add components/clients/clients-workspace.tsx tests/e2e/clients.spec.ts
git commit -m "$(cat <<'EOF'
phaseUX-CAT-01: Clients — garde la course de sélection de fiche (compteur de génération)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01M5bNPykcAJ6AquidVkpfwQ
EOF
)"
```

---

### Task 14: History — sort by `sort_at`, add truncation indicator

**Files:**
- Modify: `lib/actions/customers.ts`

**Interfaces:**
- Consumes: `orders.sort_at` (generated column, `coalesce(created_at_shopify, created_at)`, migration `0044` — already selected/ordered on elsewhere in `lib/actions/orders.ts`, no migration needed here).
- Produces: `CustomerDetail.hasMoreHistory: boolean` (true when more than 30 orders exist).

- [ ] **Step 1: Change the history query**

```typescript
supabase
  .from('orders')
  .select(
    'id, order_number, total_amount, currency, cod_status, created_at_shopify, created_at, sort_at',
  )
  .eq('merchant_account_id', ctx.member.merchantAccountId)
  .eq('shop_id', parsedInput.shopId)
  .eq('customer_id', parsedInput.customerId)
  .order('sort_at', { ascending: false })
  .limit(31), // +1 pour détecter la troncature sans un second aller-retour
```

- [ ] **Step 2: Slice to 30, expose `hasMoreHistory`**

```typescript
const rawHistory = (historyResult.data ?? []) as CustomerOrderHistoryItem[];
const hasMoreHistory = rawHistory.length > 30;
const history = hasMoreHistory ? rawHistory.slice(0, 30) : rawHistory;

const detail: CustomerDetail = {
  ...customer,
  // ...
  hasMoreHistory,
  history,
};
```

Add `hasMoreHistory: boolean;` to the `CustomerDetail` type.

- [ ] **Step 3: Render the indicator (`clients-workspace.tsx`, history section)**

```tsx
<h3 className="text-sm font-semibold">
  {t('history.title')}
  {customer.hasMoreHistory && (
    <span className="ml-2 font-normal text-muted">— 30 les plus récentes affichées</span>
  )}
</h3>
```

- [ ] **Step 4: Write a regression unit test proving the sort key change**

Since `getCustomerAction` is a `'use server'` action calling Supabase directly, add coverage at the query-shape level instead (this codebase's existing pattern for server actions it doesn't unit-test directly is e2e coverage — verify there is no existing unit harness for `lib/actions/customers.ts` before deciding; if none, defer this proof to the e2e case in Task 17, matching the codebase's established split between unit-tested pure modules and e2e-tested server actions).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add lib/actions/customers.ts components/clients/clients-workspace.tsx
git commit -m "$(cat <<'EOF'
phaseUX-CAT-01: Clients — historique trié sur sort_at (pas created_at_shopify seul) + indicateur de troncature

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01M5bNPykcAJ6AquidVkpfwQ
EOF
)"
```

---

### Task 15: "Voir commandes" filtered by client

**Files:**
- Modify: `components/clients/clients-workspace.tsx`

**Interfaces:**
- Consumes: the existing phone-match branch of `matchesOrderSearch` (`lib/orders/search.ts:73-93`) via the `/commandes?q=` route — no new destination, no new filter mechanism.

- [ ] **Step 1: `DetailActionBar`'s "Voir commandes" link**

```tsx
<Link
  className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-accent px-3 text-sm font-medium text-accent-ink hover:bg-accent-hover"
  href={
    customer.phone
      ? `/s/${storeId}/commandes?q=${encodeURIComponent(customer.phone)}`
      : `/s/${storeId}/commandes`
  }
>
  {t('actions.orders')}
  <ArrowRight aria-hidden="true" className="size-4" />
</Link>
```

- [ ] **Step 2: `ClientRow`'s overflow "Voir commandes" item**

```typescript
{
  key: 'orders',
  label: t('actions.orders'),
  icon: <Package className="size-4" />,
  onSelect: () =>
    router.push(
      phone ? `/s/${storeId}/commandes?q=${encodeURIComponent(phone)}` : `/s/${storeId}/commandes`,
    ),
},
```

- [ ] **Step 3: Document the phoneless-customer fallback in the PR2 report**

A customer with no phone falls back to the unfiltered list (no regression vs. today), flagged as a known residual gap rather than silently pretending to filter.

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add components/clients/clients-workspace.tsx
git commit -m "$(cat <<'EOF'
phaseUX-CAT-01: Clients — "Voir commandes" filtre par téléphone (réutilise /commandes?q=, aucune nouvelle destination)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01M5bNPykcAJ6AquidVkpfwQ
EOF
)"
```

---

### Task 16: Paramètres — SHOP-01 regression check + shop-selector constat (no shell change)

**Files:**
- none (verification + report only)

- [ ] **Step 1: Verify `/parametres?tab=` deep-linking and OAuth callback messages still work post-`SHOP-01`**

Manually exercise, on the dedicated test account/shop: `/s/{storeId}/parametres?tab=shops`, an OAuth connect/disconnect round trip's success/error banner. Run the existing e2e coverage for this area if present (`grep -rl "parametres" tests/e2e/`) and confirm green — do not add new tests here, this task is a non-regression check, not new coverage.

- [ ] **Step 2: Record the shop-selector visibility constat**

From this session's reading of `app/(app)/layout.tsx` + `components/app-shell/sidebar.tsx:92` + `components/app-shell/bottom-tab-nav.tsx:161-186`: the active shop is **always visible** on desktop (`StoreSwitcher` in the persistent sidebar) but **only reachable via the bottom-nav "More" overflow menu on mobile** (`bottom-tab-nav.tsx:173-178`, deliberately — the code comment there states it avoids consuming permanent content height). This means a mobile user can perform an action believing they are in a different shop than the one actually active, with no permanent on-screen confirmation — the same defect class U0-D2 found at `/boutiques` scope, but at shell scope. Per this lot's scope boundary ("n'élargis pas" — fixing it means touching the global shell, not Paramètres), this constat goes into the PR2 report as a proposed follow-up lot, with no code change here.

---

### Task 17: PR2 sanity loop, e2e proof, open PR

**Files:**
- Modify: `tests/e2e/clients.spec.ts` (extend with the pagination + history-sort proofs, alongside Task 13's race-condition case already added there)

- [ ] **Step 1: Add e2e coverage for pagination (>50 clients) and history sort (mixed Shopify/appel)**

```typescript
test('un compte à plus de 50 clients les voit tous via "Voir plus"', async ({ page }) => {
  test.skip(!hasSupabaseAdmin, 'Nécessite SUPABASE_SERVICE_ROLE_KEY (stack local).');
  // Seed 120 clients synthétiques pour ce tenant/boutique de test.
  await page.goto(`/s/${storeId}/clients`);
  await expect(page.getByText('Voir plus')).toBeVisible();
  await page.getByText('Voir plus').click();
  await expect(page.getByText('Voir plus')).toBeVisible(); // encore une page (120 > 200)... ajuster selon le seed réel
  // ... continuer jusqu'à épuisement, puis compter les lignes rendues === 120
});

test('historique client : une commande par appel plus récente qu\'une commande Shopify apparaît avant elle', async ({ page }) => {
  test.skip(!hasSupabaseAdmin, 'Nécessite SUPABASE_SERVICE_ROLE_KEY (stack local).');
  // Seed un client avec 1 commande Shopify ancienne (created_at_shopify vieux)
  // et 1 commande "appel" récente (created_at_shopify NULL, created_at récent).
  // Avant le fix (tri sur created_at_shopify seul) : la commande appel apparaît
  // après. Après le fix (tri sur sort_at) : elle apparaît en premier.
});
```

(Fill in seeding using this file's existing helper conventions — check `hasSupabaseAdmin`/`adminClient()` usage already present in `clients.spec.ts` before inventing a new seeding path.)

- [ ] **Step 2: Full sanity loop**

```bash
pnpm typecheck
pnpm lint
pnpm vitest run
$env:VERCEL_ENV='preview'; pnpm build
pnpm test:rls
pnpm security:acl-baseline:check
```

Expected: all green.

- [ ] **Step 3: `git diff --stat main..HEAD`, then open PR2**

Follow `batch-workflow`. Two distinct workflow runs (close/reopen), record both run ids + tree SHAs.

PR2 report must include: the two founder arbitrages and what was implemented (score removed, button disabled — both per this session's explicit decisions, not the implementer's call); the SHOP-01 regression check result; the shop-selector visibility constat (Task 16, proposed as a separate follow-up lot, not fixed here); red→green proof of the selection race (Task 13); pagination proof (>50 clients); history sort+truncation proof; the documented "date de dernière commande" data gap; the three widths; keyboard pass; what remains open.

---

## Deferred / explicitly out of scope (do not implement, name in both PR reports)

- The client reliability score's numeric display and its underlying formula — resolved this session (removed), but the score computation itself (`customer_reliability_projection`, migration `0132`) is untouched.
- `getFinanceChartsAction` pagination, the legacy purchase-lot shop guard (U0-D2 P0 #0), `/boutiques` context bug (U0-D2 P0 #1) — Finances/Achats/Plus are out of this lot's scope per the spec's own "Hors périmètre" section.
- The driver stock table / cash — `CASH-01`.
- Any migration.
