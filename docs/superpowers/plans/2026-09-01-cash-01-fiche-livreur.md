# CASH-01 — Fiche livreur : portée temporelle, retrait de l'écart, remise confirmée

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four presentation/semantic defects on `/livreurs`' cash panel (no scope label under amounts, ambiguous card names, a persistent "Écart non résolu" red banner that isn't an anomaly, and a settlement form with no confirmation step), and remove the "Réinitialiser" period-filter button per the founder's follow-up ask — without touching any calculation, RPC, or migration.

**Architecture:** All changes are confined to `components/drivers/driver-cash-panel.tsx`, `components/drivers/driver-remittance-form.tsx`, `lib/actions/drivers.ts` (one new field, no new query), `messages/fr.json`, `docs/lexique-microcopie.md`, and `tests/e2e/drivers.spec.ts`. No SQL, no migration.

**Tech Stack:** Next.js App Router (RSC + client component), next-safe-action, next-intl (`messages/fr.json`), Playwright e2e.

## Global Constraints

- **No formula/RPC/migration change.** `record_cash_settlement` (migration `0018`) already writes `created_by`=`auth.uid()` (checked, `raise exception 'invalid_actor'` otherwise) and is the *only* write path for both the manual form and the "live card" shortcut — confirmed by reading `driver-remittance-form.tsx`, `driver-cash-panel.tsx`, and `0018_finance_settlement_rpc.sql`. **The P0 traceability question the spec raised about a "Réinitialiser" button that zeroes the balance without a trace does not apply to this codebase** — no such dangerous button exists; the settlement shortcut is already traced. There *is* a control literally labeled "Réinitialiser" (key `livreurs.cash.resetPeriod`), but it's an unrelated, purely client-side date-filter reset (`selectPreset('30j')`, no server write, no cash effect) — the founder asked for it to be removed outright regardless (Task 3), which this plan does. Do not add a migration for this plan.
- Vouvoiement, XOF sans décimale, séparateur espace insécable (`formatMoney`/`formatFCFA` already do this — reuse them, never reformat manually).
- Three widths to verify with no truncation/overflow: **390, 412, 1280 px**.
- Touch tap targets ≥ 44px (`min-h-11`/`min-h-9` classes already used in this file — keep using them).
- Reduce color-as-signal: no orange (`accent`/`text-accent`, `--accent:#ee8243`) on a value merely because it's important; no red without a real anomaly.
- Card labels are founder-arbitrated — reuse verbatim, do not reword:
  | Card (i18n key) | New label | Scope shown under amount |
  |---|---|---|
  | `collectedTotal` | Collecté sur période | période sélectionnée (date range) |
  | `deliveryFees` | Frais de livraison (unchanged) | période sélectionnée (date range) |
  | `cashOnHand` | Cash chez le livreur (live) (unchanged) | horodatage — « au {date} » |
  | `cashOnHandPeriod` | Cash chez le livreur sur période | période sélectionnée (date range) |
- One commit per deliverable (rule #5, CLAUDE.md) — this plan is one deliverable, one commit at the end covering all tasks (small enough not to split; if you deviate, get sign-off first).

---

## File Structure

- Modify `lib/actions/drivers.ts` — add `asOfIso` (server-computed timestamp) to `DriverCashData`.
- Modify `components/drivers/driver-cash-panel.tsx` — scope sub-labels, renamed cards, drop orange accent, remove the "Écart non résolu" banner, remove the "Réinitialiser" period-filter button, pass `expectedMinor` to the form.
- Modify `components/drivers/driver-remittance-form.tsx` — add a mandatory confirmation step before calling `recordSettlementAction`.
- Modify `messages/fr.json` — rename two labels, remove `resetPeriod` and `discrepancy`.
- Modify `docs/lexique-microcopie.md` — document the écart-vs-solde rule.
- Modify `tests/e2e/drivers.spec.ts` — update 3 existing submit-click sites for the new confirm step, remove the 2 "Écart non résolu" assertions, trim the reset-button test down to its divergence proof, add one new test covering renames/scope labels/no-orange/confirmation/no-overflow.

---

### Task 1: `asOfIso` timestamp for the live card

**Files:**
- Modify: `lib/actions/drivers.ts:396-464`

**Interfaces:**
- Produces: `DriverCashData` ok-variant now carries `asOfIso: string` (ISO timestamp, captured server-side right after the RPC resolves) — consumed by Task 2.

- [ ] **Step 1: Add the field to the type and both return sites**

In `lib/actions/drivers.ts`, change:

```ts
export type DriverCashData =
  | { ok: true; consolidation: DriverCashConsolidation; periodRemittedMinor: number }
  | { ok: false; message: string };
```

to:

```ts
export type DriverCashData =
  | {
      ok: true;
      consolidation: DriverCashConsolidation;
      periodRemittedMinor: number;
      // Horodatage de lecture serveur du solde live (all-time, jamais périodable
      // — cf. commentaire ci-dessous). Affiché sous la carte "Cash chez le
      // livreur (live)" pour que sa portée (maintenant) ne se confonde jamais
      // avec celle des cartes période (fenêtre choisie). Recalculé à chaque
      // lecture, jamais persisté.
      asOfIso: string;
    }
  | { ok: false; message: string };
```

Then update the two `ok: true` return sites in `getDriverCashConsolidation`:

```ts
  if (!row) {
    // Livreur sans commande assignée : mêmes zéros que l'ancien code (tableau
    // d'orders vide → deriveDriverCashConsolidation renvoyait déjà des zéros).
    return {
      ok: true,
      consolidation: emptyDriverCashConsolidation,
      periodRemittedMinor: 0,
      asOfIso: new Date().toISOString(),
    };
  }

  return {
    ok: true,
    consolidation: {
      expectedMinor: row.expected_minor,
      collectedMinor: period ? row.period_collected_minor : row.collected_minor,
      deliveryFeesMinor: period ? row.period_delivery_fees_minor : row.delivery_fees_minor,
      collectedDeliveryFeesMinor: period
        ? row.period_collected_delivery_fees_minor
        : row.collected_delivery_fees_minor,
      remittedMinor: row.remitted_minor,
      discrepancyMinor: row.cash_on_hand_minor,
      cashOnHandMinor: row.cash_on_hand_minor,
    },
    // Carte "(période)" (migration 0100) : versements enregistrés sur la fenêtre
    // sélectionnée (settlement_allocation.created_at), distinct de remittedMinor
    // (all-time). Zéro si aucune période n'est fournie (garde SQL sur p_period_from/to).
    periodRemittedMinor: row.period_remitted_minor,
    asOfIso: new Date().toISOString(),
  };
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: no new errors. (This will surface every call site that destructures `DriverCashData`'s ok-variant with an exhaustive object type — there should be none outside `driver-cash-panel.tsx`, which Task 2 updates.)

- [ ] **Step 3: Commit is deferred to the end of this plan (single deliverable commit).**

---

### Task 2: Scope sub-labels, renamed cards, no orange, drop the écart banner

**Files:**
- Modify: `components/drivers/driver-cash-panel.tsx`

**Interfaces:**
- Consumes: `DriverCashData` with `asOfIso` (Task 1); `formatDateAbsolute`, `formatDateTime` from `@/lib/format/date`.
- Produces: `DriverRemittanceForm` now receives a new `expectedMinor: number` prop (consumed by Task 4). The period card's `resetPeriod` button, wired here exactly as it exists today, is removed in Task 3 immediately after — left untouched in this task so each task stays independently testable.

- [ ] **Step 1: Import the date formatters**

Add to the top imports:

```ts
import { formatDateAbsolute, formatDateTime } from '@/lib/format/date';
```

- [ ] **Step 2: Add a `scope` line to both card-rendering helpers**

Replace `statCard`:

```ts
function statCard(label: string, value: string, scope: string) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4 shadow-1">
      <p className="text-[13px] font-medium text-muted">{label}</p>
      <p className="mt-2 font-mono text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-muted">{scope}</p>
    </section>
  );
}
```

Replace `cashCardWithDefinition` (keep its existing doc comment above unchanged — only the body and signature change):

```ts
function cashCardWithDefinition({
  action,
  definition,
  emphasize,
  label,
  scope,
  value,
}: {
  action?: React.ReactNode;
  definition: string;
  // Remplace l'ancien flag `accent` (texte orange, --accent:#ee8243) : la carte
  // "live" reste la carte dominante de l'écran par la TAILLE, jamais la couleur
  // — "le solde ne doit pas être orange parce qu'il est important" (CASH-01).
  emphasize?: boolean;
  label: string;
  scope: string;
  value: string;
}) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4 shadow-1">
      <p className="text-[13px] font-medium text-muted">{label}</p>
      <p
        className={`mt-2 font-mono font-semibold tabular-nums ${emphasize ? 'text-3xl' : 'text-2xl'}`}
      >
        {value}
      </p>
      <p className="mt-1 text-xs text-muted">{scope}</p>
      {/* `flex-wrap` : une action au libellé long (« Enregistrer un versement »)
          déborde sinon de la carte et se retrouve SOUS la carte voisine de la
          grille, qui intercepte alors le clic. On n'ajoute que le retour à la
          ligne — le modèle de boîte (flex) reste identique, donc les cartes dont
          l'action tient déjà sur la ligne sont inchangées. */}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <DefinitionToggle definition={definition} />
        {action}
      </div>
    </section>
  );
}
```

Note: the value `<p>` stays the direct second `<p>` sibling of the label `<p>` in both helpers (the new scope `<p>` comes *after* it) — this preserves `statValue()`'s `xpath=following-sibling::p[1]` resolution in `tests/e2e/drivers.spec.ts:226`, per the existing comment above `cashCardWithDefinition` in this file. Do not reorder.

- [ ] **Step 3: Compute the period-scope label and the live as-of label, and pass them into all 4 cards**

Inside `DriverCashPanel`, after the existing `resolvePeriodRange` call in `refreshCash` — hoist an unconditional read of the same range so it's available for rendering too. Add right after the `const { selectPreset } = usePeriodParams();` line:

```ts
  const periodRange = resolvePeriodRange({
    allowedPresets: PERIOD_PRESETS,
    defaultPreset: '30j',
    from: searchParams.get('from') ?? undefined,
    period: searchParams.get('period') ?? undefined,
    to: searchParams.get('to') ?? undefined,
  });
  const periodScope = `${formatDateAbsolute(periodRange.from)} – ${formatDateAbsolute(periodRange.to)}`;
```

Then simplify `refreshCash` to reuse it instead of recomputing:

```ts
  const refreshCash = () => {
    const period = { from: periodRange.from.toISOString(), to: periodRange.to.toISOString() };

    startTransition(async () => {
      const [nextCash, nextHistory] = await Promise.all([
        getDriverCashConsolidation(driverId, period),
        getDriverSettlementHistory(driverId),
      ]);
      setCash(nextCash);
      if (nextHistory.ok) setHistory(nextHistory.rows);
    });
  };
```

Now update the render section (everything from `if (!cash.ok)` through the closing `</>`)  — the live-card as-of label needs `cash.asOfIso`, which is only available once `cash.ok` is confirmed, so compute it right after the existing `const c = cash.consolidation;` line:

```ts
  const c = cash.consolidation;
  const asOfScope = `au ${formatDateTime(cash.asOfIso)}`;
  const periodCashOnHandMinor = derivePeriodCashOnHand({
    periodCollectedMinor: c.collectedMinor,
    periodCollectedDeliveryFeesMinor: c.collectedDeliveryFeesMinor,
    periodRemittedMinor: cash.periodRemittedMinor,
  });
```

Then replace the 4-card grid:

```tsx
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {statCard(t('collectedTotal'), formatMoney(c.collectedMinor, 'XOF'), periodScope)}
        {statCard(t('deliveryFees'), formatMoney(c.collectedDeliveryFeesMinor, 'XOF'), periodScope)}
        {cashCardWithDefinition({
          emphasize: true,
          // Partie 2 — raccourci de règlement. Ce bouton n'enregistre RIEN : il
          // propose au formulaire déjà monté ci-dessous le solde live affiché sur
          // cette carte, puis y amène le marchand. Le mécanisme de versement
          // (recordSettlementAction → record_cash_settlement) reste inchangé et
          // reste le seul chemin d'écriture, avec son RBAC owner/manager existant.
          action: (
            <button
              className="min-h-9 rounded-full border border-border px-2 py-1 text-[11px] font-medium text-muted hover:bg-canvas hover:text-text"
              data-testid="driver-cash-settle-shortcut"
              onClick={() =>
                setPrefill((previous) => ({
                  amountMinor: c.cashOnHandMinor,
                  nonce: (previous?.nonce ?? 0) + 1,
                }))
              }
              type="button"
            >
              {t('settleNow')}
            </button>
          ),
          definition: t('cashOnHandLiveDefinition'),
          label: t('cashOnHand'),
          scope: asOfScope,
          value: formatMoney(c.cashOnHandMinor, 'XOF'),
        })}
        {cashCardWithDefinition({
          action: (
            <button
              className="shrink-0 rounded-full border border-border px-2 py-1 text-[11px] font-medium text-muted hover:bg-canvas hover:text-text"
              onClick={() => selectPreset(DEFAULT_PERIOD_PRESET)}
              type="button"
            >
              {t('resetPeriod')}
            </button>
          ),
          definition: t('cashOnHandPeriodDefinition'),
          label: t('cashOnHandPeriod'),
          scope: periodScope,
          value: formatMoney(periodCashOnHandMinor, 'XOF'),
        })}
      </div>
```

- [ ] **Step 4: Remove the "Écart non résolu" banner and pass `expectedMinor` to the form**

Delete this block entirely:

```tsx
      {c.discrepancyMinor > 0 && (
        <p className="text-sm font-medium text-danger">
          {t('discrepancy', { amount: formatMoney(c.discrepancyMinor, 'XOF') })}
        </p>
      )}
```

Change the `DriverRemittanceForm` usage from:

```tsx
        <DriverRemittanceForm driverId={driverId} onSettled={refreshCash} prefill={prefill} />
```

to:

```tsx
        <DriverRemittanceForm
          driverId={driverId}
          expectedMinor={c.cashOnHandMinor}
          onSettled={refreshCash}
          prefill={prefill}
        />
```

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: fails until Task 4 adds the `expectedMinor` prop to `DriverRemittanceForm` — that's expected at this point; proceed to Task 3 (button removal, same file) and Task 4 before verifying green.

---

### Task 3: Remove the "Réinitialiser" period-filter button

The founder asked to remove this button outright rather than leave it on the period card. It is unrelated to the settlement/écart work above (purely a `PeriodPicker` date-filter reset, `selectPreset('30j')`, no server write) — this task deletes it and its now-dead plumbing.

**Files:**
- Modify: `components/drivers/driver-cash-panel.tsx`
- Modify: `messages/fr.json:321-334`
- Modify: `tests/e2e/drivers.spec.ts` (~line 1046-1094)

**Interfaces:**
- Consumes: the period card built in Task 2 (`cashCardWithDefinition` call for `cashOnHandPeriod`).
- Produces: no interface change for later tasks — this only removes dead code and one i18n key.

- [ ] **Step 1: Drop the button from the period card**

In `components/drivers/driver-cash-panel.tsx`, change the `cashOnHandPeriod` card (built in Task 2 Step 3) from:

```tsx
        {cashCardWithDefinition({
          action: (
            <button
              className="shrink-0 rounded-full border border-border px-2 py-1 text-[11px] font-medium text-muted hover:bg-canvas hover:text-text"
              onClick={() => selectPreset(DEFAULT_PERIOD_PRESET)}
              type="button"
            >
              {t('resetPeriod')}
            </button>
          ),
          definition: t('cashOnHandPeriodDefinition'),
          label: t('cashOnHandPeriod'),
          scope: periodScope,
          value: formatMoney(periodCashOnHandMinor, 'XOF'),
        })}
```

to:

```tsx
        {cashCardWithDefinition({
          definition: t('cashOnHandPeriodDefinition'),
          label: t('cashOnHandPeriod'),
          scope: periodScope,
          value: formatMoney(periodCashOnHandMinor, 'XOF'),
        })}
```

- [ ] **Step 2: Remove the now-dead hook call, import, and constant**

Delete the line `const { selectPreset } = usePeriodParams();` (it sits right next to the `periodRange`/`periodScope` block added in Task 2 Step 3 — remove only this line, keep `periodRange`/`periodScope`).

Delete the import:

```ts
import { usePeriodParams } from '@/components/period-picker/use-period-params';
```

Delete the constant and its comment near the top of the file:

```ts
// Même défaut que resolvePeriodRange dans app/(app)/livreurs/page.tsx:92 — le
// bouton reset ramène le PeriodPicker déjà monté (drivers-workspace.tsx) à ce
// preset, purement client (usePeriodParams().selectPreset), aucune écriture serveur.
const DEFAULT_PERIOD_PRESET = '30j';
```

- [ ] **Step 3: Remove the i18n key**

In `messages/fr.json`'s `livreurs.cash` block, delete the line:

```json
      "resetPeriod": "Réinitialiser",
```

- [ ] **Step 4: Trim the e2e test that exercised this button**

The test titled `'cash livreur (période): diverge légitimement du live sur une commande hors fenêtre, puis le reset recharge la carte'` (~line 1046) proves two things: (a) the period and live cards can legitimately diverge, and (b) clicking reset reloads the period card. Only (a) survives. Rename the test (drop `, puis le reset recharge la carte`) and delete the reset-button block plus its trailing assertion:

```ts
    // Bouton reset (purement client, usePeriodParams().selectPreset) : ramène l'URL au
    // preset par défaut (30j) — même mécanisme que recliquer ce preset dans le
    // PeriodPicker déjà monté sur la page. La commande de 10 jours entre alors dans la
    // fenêtre : la carte "(période)" rejoint la carte "(live)" (plus aucune commande hors
    // fenêtre pour ce jeu de données), preuve que le reset recharge réellement la carte.
    await page
      .getByRole('button', { name: messages.livreurs.cash.resetPeriod, exact: true })
      .click();
    await expect(page).toHaveURL(/period=30j/);
    await expect(statValue(page, messages.livreurs.cash.cashOnHandPeriod)).toContainText(
      /18\s*000\s*F\s*CFA/,
      { timeout: 15_000 },
    );
```

The test now ends right after the two `statValue` assertions that were already above that block (the divergence proof: live=18000, période=0).

- [ ] **Step 5: Grep for orphan references**

Run: `grep -rn "resetPeriod" components/ lib/ tests/ messages/`
Expected: no matches (this task removed the only 3 sites: the button in `driver-cash-panel.tsx`, the key in `fr.json`, the click in `drivers.spec.ts`).

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: still fails on the missing `expectedMinor` prop until Task 4 — same expected-fail state as the end of Task 2.

---

### Task 4: `DriverRemittanceForm` — mandatory confirmation step

**Files:**
- Modify: `components/drivers/driver-remittance-form.tsx`

**Interfaces:**
- Consumes: new `expectedMinor: number` prop from Task 2 (the live `cashOnHandMinor` at render time — the "montant attendu").
- Produces: no external interface change — `recordSettlementAction` call site and payload are unchanged; only *when* it fires changes (now gated behind an explicit second click).

- [ ] **Step 1: Add `expectedMinor` to props and a `pendingConfirm` state**

```ts
type Props = {
  driverId: string;
  // Solde live affiché par la carte "Cash chez le livreur (live)" au moment du
  // rendu — "montant attendu" de l'écran de confirmation. Snapshot, pas relu à
  // la confirmation : si le solde a bougé entre-temps (autre remise en //),
  // record_cash_settlement recalcule quand même server-side sur les vraies
  // allocations — ce montant n'est qu'informatif, jamais transmis à la RPC.
  expectedMinor: number;
  prefill?: { amountMinor: number; nonce: number } | null;
  onSettled?: () => void;
};
```

Update the function signature: `export function DriverRemittanceForm({ driverId, expectedMinor, onSettled, prefill }: Props) {`

Add state right after `amountInputRef`:

```ts
  const [pendingConfirm, setPendingConfirm] = useState(false);
```

- [ ] **Step 2: Reset the confirmation whenever the amount or method changes**

Change the amount input's `onChange` from `onChange={(e) => setAmount(e.target.value)}` to:

```ts
          onChange={(e) => {
            setAmount(e.target.value);
            setPendingConfirm(false);
          }}
```

Change the method select's `onChange` similarly:

```ts
          onChange={(e) => {
            setMethod(e.target.value as (typeof settlementMethods)[number]);
            setPendingConfirm(false);
          }}
```

Also reset it in the prefill effect — add `setPendingConfirm(false);` right after `setFeedback(null);` inside the `useEffect`.

- [ ] **Step 3: Split `submit` into "request confirmation" and "actually submit"**

Replace the `submit` function with:

```ts
  function requestConfirm() {
    const a = Number.parseInt(amount, 10);
    if (!Number.isFinite(a) || a < 0) {
      setFeedback({ msg: 'Montant invalide (≥ 0).', kind: 'error' });
      return;
    }
    setFeedback(null);
    setPendingConfirm(true);
  }

  async function confirmSubmit() {
    const a = Number.parseInt(amount, 10);
    const res = await action.executeAsync({
      driverId,
      amountReceivedMinor: a,
      method,
      clientRequestId: crypto.randomUUID(),
    });
    if (res?.data?.ok) {
      setFeedback({ msg: 'Versement enregistré.', kind: 'success' });
      setAmount('');
      setPendingConfirm(false);
      onSettled?.();
    } else {
      setFeedback({ msg: "Erreur lors de l'enregistrement du versement.", kind: 'error' });
    }
  }
```

- [ ] **Step 4: Render the confirmation block and wire the buttons**

Replace the submit `<button>` (`{action.isExecuting ? 'En cours…' : 'Enregistrer le versement'}`) so the row becomes:

```tsx
      {!pendingConfirm ? (
        <button
          className="min-h-11 rounded-md bg-accent px-4 text-sm font-semibold text-[#111] hover:bg-accent-hover disabled:opacity-60"
          onClick={requestConfirm}
          type="button"
        >
          Enregistrer le versement
        </button>
      ) : null}
```

Then, right after the closing `</label>` for "Moyen" and before the feedback `<p>`, add the confirmation panel as a sibling that replaces the button row when `pendingConfirm` is true — restructure the returned JSX so the button row and the confirmation row are mutually exclusive:

```tsx
  const parsedAmount = Number.parseInt(amount, 10);
  const restMinor = pendingConfirm ? Math.max(expectedMinor - parsedAmount, 0) : 0;

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="space-y-1">
        <span className="text-xs text-muted">Montant reçu (FCFA)</span>
        <input
          className="min-h-11 w-36 rounded-md border border-border bg-canvas px-2 text-sm"
          disabled={pendingConfirm}
          min="0"
          onChange={(e) => {
            setAmount(e.target.value);
            setPendingConfirm(false);
          }}
          placeholder="0"
          ref={amountInputRef}
          type="number"
          value={amount}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs text-muted">Moyen</span>
        <select
          className="min-h-11 w-40 rounded-md border border-border bg-canvas px-2 text-sm"
          disabled={pendingConfirm}
          onChange={(e) => {
            setMethod(e.target.value as (typeof settlementMethods)[number]);
            setPendingConfirm(false);
          }}
          value={method}
        >
          {settlementMethods.map((m) => (
            <option key={m} value={m}>
              {methodLabels[m]}
            </option>
          ))}
        </select>
      </label>
      {!pendingConfirm ? (
        <button
          className="min-h-11 rounded-md bg-accent px-4 text-sm font-semibold text-[#111] hover:bg-accent-hover disabled:opacity-60"
          onClick={requestConfirm}
          type="button"
        >
          Enregistrer le versement
        </button>
      ) : (
        <div className="flex w-full flex-col gap-2 rounded-md border border-border bg-canvas p-3 text-sm">
          <p>
            Montant attendu : <span className="font-semibold">{formatMoney(expectedMinor)}</span>
          </p>
          <p>
            Montant saisi : <span className="font-semibold">{formatMoney(parsedAmount)}</span>
          </p>
          <p>
            Reste après la remise : <span className="font-semibold">{formatMoney(restMinor)}</span>
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              className="min-h-11 rounded-md bg-accent px-4 text-sm font-semibold text-[#111] hover:bg-accent-hover disabled:opacity-60"
              disabled={action.isExecuting}
              onClick={confirmSubmit}
              type="button"
            >
              {action.isExecuting ? 'En cours…' : 'Confirmer le versement'}
            </button>
            <button
              className="min-h-11 rounded-md border border-border px-4 text-sm font-medium text-muted hover:bg-surface"
              onClick={() => setPendingConfirm(false)}
              type="button"
            >
              Modifier
            </button>
          </div>
        </div>
      )}
      {feedback && (
        <p
          className={cn(
            'text-xs font-medium',
            feedback.kind === 'error' ? 'text-danger' : 'text-success',
          )}
          role="alert"
        >
          {feedback.msg}
        </p>
      )}
    </div>
  );
}
```

Add the `formatMoney` import: `import { formatMoney } from '@/lib/format/fcfa';`

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (this closes the gap left at the end of Task 2 / Task 3).

---

### Task 5: i18n — rename two labels, remove `discrepancy`

**Files:**
- Modify: `messages/fr.json:321-333` (post-Task-3, the block no longer has `resetPeriod`)

- [ ] **Step 1: Edit the `livreurs.cash` block**

Change:

```json
    "cash": {
      "due": "Dû / attendu",
      "collectedTotal": "Cash total collecté",
      "deliveryFees": "Frais de livraison",
      "remitted": "Remis",
      "cashOnHand": "Cash chez le livreur (live)",
      "cashOnHandLiveDefinition": "Ce solde ne se remet jamais à zéro tout seul : c'est tout le cash que le livreur a encore en main depuis le début, moins ce qu'il a déjà remis. Il peut différer de la carte « (période) » ci-contre, qui ne regarde que la fenêtre de dates choisie — ce n'est pas une erreur.",
      "cashOnHandPeriod": "Cash chez le livreur (période)",
      "cashOnHandPeriodDefinition": "Cette carte est un instantané de l'activité sur la période choisie : le cash collecté sur ces commandes, moins les frais et les versements enregistrés sur cette même fenêtre. Un versement peut couvrir des commandes hors de cette période, donc ce chiffre peut différer du solde « (live) » ci-contre — ce n'est pas une erreur.",
      "settleNow": "Enregistrer un versement",
      "remittanceTitle": "Enregistrer un versement (remise globale)",
      "discrepancy": "Écart non résolu : {amount}"
    },
```

to:

```json
    "cash": {
      "due": "Dû / attendu",
      "collectedTotal": "Collecté sur période",
      "deliveryFees": "Frais de livraison",
      "remitted": "Remis",
      "cashOnHand": "Cash chez le livreur (live)",
      "cashOnHandLiveDefinition": "Ce solde ne se remet jamais à zéro tout seul : c'est tout le cash que le livreur a encore en main depuis le début, moins ce qu'il a déjà remis. Il peut différer de la carte « sur période » ci-contre, qui ne regarde que la fenêtre de dates choisie — ce n'est pas une erreur.",
      "cashOnHandPeriod": "Cash chez le livreur sur période",
      "cashOnHandPeriodDefinition": "Cette carte est un instantané de l'activité sur la période choisie : le cash collecté sur ces commandes, moins les frais et les versements enregistrés sur cette même fenêtre. Un versement peut couvrir des commandes hors de cette période, donc ce chiffre peut différer du solde « (live) » ci-contre — ce n'est pas une erreur.",
      "settleNow": "Enregistrer un versement",
      "remittanceTitle": "Enregistrer un versement (remise globale)"
    },
```

(`discrepancy` is dropped — no other file references `messages.livreurs.cash.discrepancy` or the i18n key `livreurs.cash.discrepancy`; verified by Step 2's grep before deleting the last usage.)

- [ ] **Step 2: Confirm no orphan reference before removing the key**

Run: `grep -rn "cash.discrepancy\|t('discrepancy')" components/ lib/ tests/`
Expected: no matches once Task 2 Step 4 (banner removal) is applied. If any remain, fix them before proceeding.

---

### Task 6: `docs/lexique-microcopie.md` — écart vs solde

**Files:**
- Modify: `docs/lexique-microcopie.md`

- [ ] **Step 1: Add a new section** after `## Mécanismes conservés (à ne pas confondre avec les notions interdites)` (i.e. insert before `## Page de démonstration retirée (Lot F2-bis)`):

```markdown
## Écart vs solde (Lot CASH-01)

**« Écart » et « solde non remis » ne sont pas synonymes.** Un écart, c'est `attendu − reçu`
*après une remise* ; sans remise, il n'y a pas d'écart — seulement un solde (ce que le livreur
détient encore, en attente d'être remis). La carte « Cash chez le livreur (live) »
(`driver-cash-panel.tsx`) affichait un solde non nul en permanence comme « Écart non résolu »
en rouge (`text-danger`) : un marchand qui le voit tous les jours apprend à l'ignorer, et ne
verra pas un vrai écart le jour où il apparaît. **La bannière est retirée** (Lot CASH-01,
2026-09-01) — le solde reste visible via la carte elle-même, sans alarme de couleur. Le seul
endroit où le mot « écart »/« reste » peut légitimement apparaître est le récapitulatif de
confirmation d'un versement (`driver-remittance-form.tsx`, « Reste après la remise »), où il
compare une vraie action en cours (attendu vs. saisi) — jamais comme état permanent d'une carte.
```

---

### Task 7: E2E — confirmation step, no écart banner, new coverage

**Files:**
- Modify: `tests/e2e/drivers.spec.ts`

- [ ] **Step 1: Add a confirm click at the 3 existing submit sites**

At line ~611 (test `cash livreur: le raccourci de la carte live prérempli le versement avec le solde`), change:

```ts
    await page.getByRole('button', { name: 'Enregistrer le versement' }).click();
    await expect(page.getByText('Versement enregistré.')).toBeVisible({ timeout: 15_000 });
```

to:

```ts
    await page.getByRole('button', { name: 'Enregistrer le versement' }).click();
    await expect(page.getByText('Montant attendu :')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Confirmer le versement' }).click();
    await expect(page.getByText('Versement enregistré.')).toBeVisible({ timeout: 15_000 });
```

At line ~659 (test `cash livreur: commande livrée affiche le collecté puis la remise globale met à jour le remis`), apply the same change to its `'Enregistrer le versement'`/`'Versement enregistré.'` pair.

Inside the `remit()` helper (~line 875-889, used by the écart test), change:

```ts
    await page.getByRole('button', { name: 'Enregistrer le versement' }).click();
    const grouped = String(expectedCashOnHandMinor).replace(/\B(?=(\d{3})+(?!\d))/g, '\\s*');
    await expect(page.getByText('Versement enregistré.')).toBeVisible({
      timeout: 15_000,
    });
```

to:

```ts
    await page.getByRole('button', { name: 'Enregistrer le versement' }).click();
    await page.getByRole('button', { name: 'Confirmer le versement' }).click();
    const grouped = String(expectedCashOnHandMinor).replace(/\B(?=(\d{3})+(?!\d))/g, '\\s*');
    await expect(page.getByText('Versement enregistré.')).toBeVisible({
      timeout: 15_000,
    });
```

- [ ] **Step 2: Drop the two "Écart non résolu" assertions and rename the test**

The test at ~line 862 is titled `'ecart cash: remise partielle affiche le bandeau, remise du solde le fait disparaitre'`. Rename it to `'cash livreur: remise partielle laisse un solde, remise complète le ramène à zéro'` and delete these two lines (the `remit()` calls right above/below them already assert the *value* transition 100000→50000→0 on the live card, which is the real coverage — the banner assertions were redundant with the removed UI element):

```ts
    await expect(page.getByText('Écart non résolu')).toBeVisible({ timeout: 15_000 });
```

```ts
    await expect(page.getByText('Écart non résolu')).toHaveCount(0, { timeout: 15_000 });
```

- [ ] **Step 3: Run the updated existing tests**

Run: `pnpm exec playwright test tests/e2e/drivers.spec.ts --project=chromium -g "cash livreur|ecart cash"`
Expected: all PASS. (Needs the local Supabase stack running per `pnpm exec supabase migration up --local`, and Playwright manages its own `pnpm dev` — do not pre-start it, per CLAUDE.md.)

- [ ] **Step 4: Add one new test covering renames, scope labels, no-orange, confirmation content, and no-overflow at 3 widths**

Add this test after the renamed écart test (or at the end of the cash-related block):

```ts
test('cash livreur: portee temporelle visible, pas de bandeau ecart, confirmation avant remise, aucun debordement', async ({
  page,
}) => {
  const fixture = await createOwnerFixture('cash-cash01');
  const driverId = await createDriver(fixture.admin, fixture.merchantAccountId, 'Ndeye Cash01');
  await seedDeliveredCashOrder(fixture.admin, fixture.merchantAccountId, driverId, 30000);

  try {
    await signIn(page, fixture.email, `/livreurs?driver=${driverId}&period=30j`);
    await expect(page.getByRole('heading', { name: 'Ndeye Cash01' })).toBeVisible();

    // Noms de cartes arbitrés (plus d'ambiguïté "Cash total collecté" vs "(période)").
    await expect(page.getByText('Collecté sur période', { exact: true })).toBeVisible();
    await expect(page.getByText('Cash chez le livreur sur période', { exact: true })).toBeVisible();

    // Portée visible sous CHAQUE montant, sans dépendre de "Définition".
    const collectedCard = statValue(page, messages.livreurs.cash.collectedTotal).locator('..');
    await expect(collectedCard.getByText(/–/)).toBeVisible();
    const liveCard = statValue(page, messages.livreurs.cash.cashOnHand).locator('..');
    await expect(liveCard.getByText(/^au /)).toBeVisible();

    // Pas d'orange sur le solde live : le texte n'utilise pas --accent (#ee8243).
    await expect(statValue(page, messages.livreurs.cash.cashOnHand)).not.toHaveCSS(
      'color',
      'rgb(238, 130, 67)',
    );

    // "Écart non résolu" n'existe plus nulle part sur l'écran.
    await expect(page.getByText('Écart non résolu')).toHaveCount(0);

    // Le bouton "Réinitialiser" (reset de période) a été retiré (Task 3).
    await expect(page.getByRole('button', { name: 'Réinitialiser' })).toHaveCount(0);

    // Confirmation obligatoire : le premier clic ne soumet rien.
    const settlementInput = page.getByPlaceholder('0');
    await settlementInput.click({ clickCount: 3 });
    await settlementInput.pressSequentially('10000');
    await page.getByRole('button', { name: 'Enregistrer le versement' }).click();
    await expect(page.getByText('Versement enregistré.')).toHaveCount(0);
    await expect(page.getByText(/Montant attendu.*30\s*000\s*F\s*CFA/)).toBeVisible();
    await expect(page.getByText(/Montant saisi.*10\s*000\s*F\s*CFA/)).toBeVisible();
    await expect(page.getByText(/Reste après la remise.*20\s*000\s*F\s*CFA/)).toBeVisible();

    // "Modifier" annule sans écrire : le formulaire redevient éditable, aucune ligne.
    await page.getByRole('button', { name: 'Modifier' }).click();
    await expect(page.getByRole('button', { name: 'Confirmer le versement' })).toHaveCount(0);
    const { data: beforeConfirm } = await fixture.admin
      .from('cash_settlement')
      .select('id')
      .eq('merchant_account_id', fixture.merchantAccountId)
      .eq('driver_id', driverId);
    expect(beforeConfirm ?? []).toHaveLength(0);

    // Aucun débordement horizontal à 390 / 412 / 1280 px.
    for (const width of [390, 412, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(overflow.scrollWidth, `width=${width}`).toBeLessThanOrEqual(overflow.clientWidth + 1);
    }
  } finally {
    await cleanupUsers(fixture.admin, fixture.userIds);
  }
});
```

- [ ] **Step 5: Run the new test**

Run: `pnpm exec playwright test tests/e2e/drivers.spec.ts --project=chromium -g "portee temporelle"`
Expected: PASS.

---

### Task 8: Full sanity loop, 3-width screenshots, and shipping

**Files:** none (verification only).

- [ ] **Step 1: Run the mandated sanity loop (rule #6, CLAUDE.md)**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && $env:VERCEL_ENV='preview'; pnpm build
pnpm test:rls
pnpm security:acl-baseline:check
```

Expected: all green. `pnpm build` must use the `VERCEL_ENV=preview` prefix — a bare `pnpm build` fails locally on the `NODE_ENV` guard and is not a real failure (see CLAUDE.md).

- [ ] **Step 2: Run the full driver e2e slice locally (not the full suite — CLAUDE.md: local E2E beyond a few dozen tests is unreliable)**

```bash
pnpm exec supabase migration up --local
pnpm exec playwright test tests/e2e/drivers.spec.ts --project=chromium
```

Expected: PASS. Do not judge the whole `pnpm test:e2e` suite locally — only CI (GitHub, cold, 3 jobs) is authoritative.

- [ ] **Step 3: Capture real screenshots at the 3 widths on the rendered page** (not a DOM injection) — e.g. via `mcp__claude-in-chrome__resize_window` + screenshot, or Playwright's `page.screenshot()` inside a throwaway script, navigating to `/livreurs?driver={testDriverId}&period=30j` on a **test account/shop**, per rule #14 (CLAUDE.md) — never the owner's real account.

- [ ] **Step 4: Ship via the batch-workflow skill** (branch → PR → 2 consecutive green CI runs → founder sign-off → squash-merge). The PR description must report:
  - What the settlement shortcut (the "live card" button) did in the database, before and after this lot (answer: unchanged — already traced via `record_cash_settlement`, confirmed by code reading, no migration needed).
  - That the unrelated `Réinitialiser` period-filter button was removed outright (Task 3), per explicit founder request, distinct from the settlement shortcut.
  - The retained card names and the new lexicon entry on "écart".
  - The proof points above (renames, scope labels, no-banner, confirmation flow, no-overflow, reset button gone).
  - The 3-width screenshots.

---

## Self-Review Notes

- **Spec coverage:** portée temporelle sub-labels (Task 2), card renames (Tasks 2+5), écart banner removal + lexicon rule (Tasks 2, 5, 6), "Réinitialiser" button removed (Task 3, founder follow-up ask), confirmation-before-write with attendu/saisi/reste (Task 4), no-orange (Task 2's `emphasize` replacing `accent`), no-red-without-anomaly (banner removed, "Reste" rendered in plain text), P0 traceability question (answered in Global Constraints — already closed, no code change), 3-width no-overflow (Task 7 Step 4, Task 8 Step 3), lexicon entry (Task 6), E2E regression from the confirm step and the button removal (Task 3 Step 4, Task 7 Steps 1-2).
- **Out of scope, confirmed untouched:** `derivePeriodCashOnHand`/`deriveDriverCashConsolidation` (no formula change), `get_driver_cash_consolidation` RPC (no SQL change), `record_cash_settlement` RPC (no SQL change).
