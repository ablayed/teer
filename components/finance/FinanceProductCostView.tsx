'use client';

import { DefinitionCard } from '@/components/ui/definition-card';
import { updateProductUnitCostAction } from '@/lib/actions/products';
import type { FinanceProductCostReport, FinanceProductCostRow } from '@/lib/finance/product-cost';
import { formatMoney } from '@/lib/format/fcfa';
import { Pencil } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import Link from 'next/link';
import { Fragment, useEffect, useMemo, useState } from 'react';

type Props = {
  from: string;
  report: FinanceProductCostReport;
  storeId: string;
  scopeNote?: string;
  to: string;
};

function money(value: number): string {
  return formatMoney(value, 'XOF');
}

// Recalcule une ligne après correction inline du prix d'achat unitaire. Reproduit
// le repli serveur (unit_cost × qté) pour que l'édition optimiste soit cohérente.
function applyUnitCost(row: FinanceProductCostRow, unitCost: number): FinanceProductCostRow {
  const purchasePriceMinor = unitCost * row.qtySold;
  const totalCostMinor = purchasePriceMinor + row.adsAllocatedMinor + row.deliveryAllocatedMinor;
  return {
    ...row,
    // unit_cost 0 → toujours « coût manquant » (colonne NOT NULL, pas de null possible).
    costMissing: unitCost <= 0,
    estimated: purchasePriceMinor > 0,
    profitAfterMinor: row.revenueMinor - totalCostMinor,
    profitBeforeMinor: row.revenueMinor - purchasePriceMinor,
    purchasePriceMinor,
    purchaseUnitMinor: row.qtySold > 0 ? Math.round(purchasePriceMinor / row.qtySold) : 0,
    totalCostMinor,
    totalCostUnitMinor: row.qtySold > 0 ? Math.round(totalCostMinor / row.qtySold) : 0,
  };
}

function CostMissingBadge() {
  const t = useTranslations('finance.products.table');
  return (
    <span
      className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800"
      title={t('costMissingHint')}
    >
      {t('costMissing')}
    </span>
  );
}

function EstimatedBadge() {
  const t = useTranslations('finance.products.table');
  return (
    <span
      className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700"
      title={t('estimatedHint')}
    >
      {t('estimated')}
    </span>
  );
}

function LowVolumeBadge() {
  const t = useTranslations('finance.products.table');
  return (
    <span
      className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700"
      title={t('lowVolumeHint')}
    >
      {t('lowVolume')}
    </span>
  );
}

function ProfitValue({ row, value }: { row: FinanceProductCostRow; value: number }) {
  const t = useTranslations('finance.products.table');
  if (row.costMissing) {
    return (
      <span className="text-muted" title={t('costMissingHint')}>
        —
      </span>
    );
  }
  return <span className={value < 0 ? 'text-danger' : 'text-success'}>{money(value)}</span>;
}

// Cellule « Prix d'achat » éditable in-cell (pattern du seuil par produit). Éditable
// uniquement quand unit_cost pilote la valeur (coût manquant ou estimé) — un COGS
// figé ne se réécrit pas ici. L'écriture passe par l'action produit existante.
function PurchaseCell({
  onUpdated,
  row,
}: {
  onUpdated: (productId: string, unitCost: number) => void;
  row: FinanceProductCostRow;
}) {
  const t = useTranslations('finance.products.table');
  const action = useAction(updateProductUnitCostAction);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [feedback, setFeedback] = useState<{ kind: 'error' | 'success'; msg: string } | null>(null);

  const editable = row.costMissing || row.estimated;

  function startEditing() {
    setValue(
      row.estimated && row.qtySold > 0
        ? String(Math.round(row.purchasePriceMinor / row.qtySold))
        : '',
    );
    setFeedback(null);
    setEditing(true);
  }

  async function submit() {
    const next = Number.parseInt(value, 10);
    if (!Number.isFinite(next) || next < 0) {
      setFeedback({ kind: 'error', msg: t('costInvalid') });
      return;
    }
    const res = await action.executeAsync({ productId: row.productId, unitCost: next });
    if (res?.data?.ok) {
      onUpdated(row.productId, next);
      setEditing(false);
    } else {
      setFeedback({ kind: 'error', msg: t('costError') });
    }
  }

  if (editing) {
    return (
      <div className="flex flex-wrap items-center justify-end gap-1">
        <input
          aria-label={t('purchaseUnitPlaceholder')}
          className="min-h-12 w-24 rounded-md border border-border bg-canvas px-2 text-right text-sm md:min-h-9"
          inputMode="numeric"
          min="0"
          onChange={(event) => setValue(event.target.value)}
          placeholder={t('purchaseUnitPlaceholder')}
          type="number"
          value={value}
        />
        <button
          className="min-h-12 rounded-md px-2 text-sm font-medium text-accent underline disabled:opacity-60 md:min-h-9"
          disabled={action.isExecuting}
          onClick={submit}
          type="button"
        >
          {action.isExecuting ? '…' : t('save')}
        </button>
        <button
          className="min-h-12 rounded-md px-2 text-sm text-muted underline md:min-h-9"
          onClick={() => setEditing(false)}
          type="button"
        >
          {t('cancel')}
        </button>
        {feedback ? <span className="text-xs font-medium text-danger">{feedback.msg}</span> : null}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-end gap-1.5">
      {row.costMissing ? (
        <CostMissingBadge />
      ) : (
        <>
          <span>{money(row.purchasePriceMinor)}</span>
          {row.estimated ? <EstimatedBadge /> : null}
        </>
      )}
      {editable ? (
        <button
          aria-label={t('editPurchase')}
          className="grid size-9 place-items-center rounded-md border border-border text-muted hover:bg-canvas hover:text-text"
          onClick={startEditing}
          title={t('editPurchase')}
          type="button"
        >
          <Pencil aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function DetailRow({ row }: { row: FinanceProductCostRow }) {
  const t = useTranslations('finance.products.table');
  return (
    <div className="grid gap-3 rounded-md border border-border bg-canvas p-3 sm:grid-cols-4">
      <div>
        <p className="text-xs text-muted">{t('ads')}</p>
        <p className="font-mono tabular-nums">{money(row.adsAllocatedMinor)}</p>
      </div>
      <div>
        <p className="text-xs text-muted">{t('delivery')}</p>
        <p className="font-mono tabular-nums">{money(row.deliveryAllocatedMinor)}</p>
      </div>
      <div>
        <p className="text-xs text-muted">{t('totalCost')}</p>
        <p className="font-mono tabular-nums">
          {row.costMissing ? <span className="text-muted">—</span> : money(row.totalCostMinor)}
        </p>
      </div>
      <div>
        <p className="text-xs text-muted">{t('profitAfter')}</p>
        <p className="font-mono tabular-nums">
          <ProfitValue row={row} value={row.profitAfterMinor} />
        </p>
      </div>
      {row.lowVolume ? (
        <div className="sm:col-span-4">
          <LowVolumeBadge />
        </div>
      ) : null}
    </div>
  );
}

// Mobile : une card par produit (pas de tableau rétréci). En-tête = nom + CA ;
// primaire = prix d'achat + bénéfice avant ; détails secondaires en dépliable.
function ProductCard({
  expanded,
  onToggle,
  onUpdated,
  row,
}: {
  expanded: boolean;
  onToggle: () => void;
  onUpdated: (productId: string, unitCost: number) => void;
  row: FinanceProductCostRow;
}) {
  const t = useTranslations('finance.products.table');
  return (
    <article className="rounded-lg border border-border bg-surface p-4 shadow-1">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium text-text">{row.title}</p>
          <p className="text-xs text-muted">
            {t('qtySold')} : {new Intl.NumberFormat('fr-FR').format(row.qtySold)}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[11px] text-muted">{t('revenue')}</p>
          <p className="font-mono text-lg font-semibold tabular-nums">{money(row.revenueMinor)}</p>
        </div>
      </div>

      <dl className="mt-3 space-y-2 text-sm">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted">{t('purchase')}</dt>
          <dd className="font-mono tabular-nums">
            <PurchaseCell onUpdated={onUpdated} row={row} />
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted">{t('profitBefore')}</dt>
          <dd className="font-mono tabular-nums">
            <ProfitValue row={row} value={row.profitBeforeMinor} />
          </dd>
        </div>
      </dl>

      <button
        aria-expanded={expanded}
        className="mt-3 min-h-12 w-full rounded-md border border-border px-3 text-xs font-medium text-muted hover:bg-canvas hover:text-text"
        onClick={onToggle}
        type="button"
      >
        {expanded ? t('hideDetails') : t('details')}
      </button>
      {expanded ? (
        <div className="mt-3">
          <DetailRow row={row} />
        </div>
      ) : null}
    </article>
  );
}

export function FinanceProductCostView({ from, report, scopeNote, storeId, to }: Props) {
  const t = useTranslations('finance.products');
  const [rows, setRows] = useState<FinanceProductCostRow[]>(report.rows);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  // Resync quand le serveur recalcule (changement de période).
  useEffect(() => {
    setRows(report.rows);
  }, [report.rows]);

  // Totaux dérivés des lignes (état) → restent cohérents après une édition optimiste.
  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, row) => ({
          profitAfter: acc.profitAfter + row.profitAfterMinor,
          profitBefore: acc.profitBefore + row.profitBeforeMinor,
          purchase: acc.purchase + row.purchasePriceMinor,
          qty: acc.qty + row.qtySold,
          revenue: acc.revenue + row.revenueMinor,
          totalCost: acc.totalCost + row.totalCostMinor,
        }),
        { profitAfter: 0, profitBefore: 0, purchase: 0, qty: 0, revenue: 0, totalCost: 0 },
      ),
    [rows],
  );

  function handleUpdated(productId: string, unitCost: number) {
    setRows((current) =>
      current.map((row) => (row.productId === productId ? applyUnitCost(row, unitCost) : row)),
    );
  }

  function toggleRow(productId: string) {
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(productId)) {
        next.delete(productId);
      } else {
        next.add(productId);
      }
      return next;
    });
  }

  return (
    <section className="space-y-5">
      <header className="rounded-lg border border-border bg-surface p-5 shadow-1">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="space-y-2">
            <h2 className="text-2xl font-semibold text-text">{t('title')}</h2>
            <p className="max-w-3xl text-sm text-muted">{t('subtitle')}</p>
            <p className="text-xs text-muted">{t('period', { from, to })}</p>
            {scopeNote ? <p className="text-xs text-muted">{scopeNote}</p> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              className="min-h-12 rounded-md border border-border px-4 py-2 text-sm font-medium text-muted hover:bg-canvas hover:text-text"
              href={`/s/${storeId}/finances?tab=global#depenses`}
            >
              {t('editExpenses')}
            </Link>
            <Link
              className="min-h-12 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-text hover:bg-accent-hover"
              href={`/s/${storeId}/commandes`}
            >
              {t('editOrders')}
            </Link>
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <DefinitionCard
            definition={t('cards.purchase.definition')}
            formula={t('cards.purchase.formula')}
            label={t('cards.purchase.label')}
            value={money(totals.purchase)}
          />
          <DefinitionCard
            definition={t('cards.totalCost.definition')}
            formula={t('cards.totalCost.formula')}
            label={t('cards.totalCost.label')}
            value={money(totals.totalCost)}
          />
          <DefinitionCard
            definition={t('cards.profitAfter.definition')}
            formula={t('cards.profitAfter.formula')}
            label={t('cards.profitAfter.label')}
            value={money(totals.profitAfter)}
          />
        </div>

        <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          {t('pilotBanner')}
        </p>

        {report.unallocatedDeliveryMinor > 0 ? (
          <p className="mt-3 text-xs text-amber-700">
            {t('unallocatedDelivery', { amount: money(report.unallocatedDeliveryMinor) })}
          </p>
        ) : null}
      </header>

      <section className="rounded-lg border border-border bg-surface p-5 shadow-1">
        <div className="mb-4 flex flex-col gap-1 md:flex-row md:items-end md:justify-between">
          <div>
            <h3 className="text-lg font-semibold">{t('table.title')}</h3>
            <p className="text-sm text-muted">{t('table.subtitle')}</p>
          </div>
          <p className="text-sm text-muted">
            {t('table.summary', {
              products: new Intl.NumberFormat('fr-FR').format(rows.length),
              profit: money(totals.profitAfter),
            })}
          </p>
        </div>

        {rows.length === 0 ? (
          <p className="text-sm text-muted">{t('empty')}</p>
        ) : (
          <>
            <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-canvas text-left">
                    <th className="px-4 py-3 font-medium">{t('table.product')}</th>
                    <th className="px-4 py-3 text-right font-medium">{t('table.qtySold')}</th>
                    <th className="px-4 py-3 text-right font-medium">{t('table.revenue')}</th>
                    <th className="px-4 py-3 text-right font-medium">{t('table.purchase')}</th>
                    <th className="px-4 py-3 text-right font-medium">{t('table.profitBefore')}</th>
                    <th className="px-4 py-3 text-right font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const expanded = expandedRows.has(row.productId);
                    return (
                      <Fragment key={row.productId}>
                        <tr className="border-b border-border last:border-0">
                          <td className="px-4 py-3">
                            <p className="font-medium text-text">{row.title}</p>
                            <p className="text-xs text-muted">{row.productId.slice(0, 8)}</p>
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums">
                            {new Intl.NumberFormat('fr-FR').format(row.qtySold)}
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums">
                            {money(row.revenueMinor)}
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums">
                            <PurchaseCell onUpdated={handleUpdated} row={row} />
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums">
                            <ProfitValue row={row} value={row.profitBeforeMinor} />
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button
                              aria-expanded={expanded}
                              className="min-h-12 rounded-md border border-border px-3 text-xs font-medium text-muted hover:bg-canvas hover:text-text"
                              onClick={() => toggleRow(row.productId)}
                              type="button"
                            >
                              {expanded ? t('table.hideDetails') : t('table.details')}
                            </button>
                          </td>
                        </tr>
                        {expanded ? (
                          <tr className="border-b border-border last:border-0">
                            <td className="px-4 pb-3" colSpan={6}>
                              <DetailRow row={row} />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                  <tr className="bg-canvas/70 font-semibold">
                    <td className="px-4 py-3">{t('table.total')}</td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">
                      {new Intl.NumberFormat('fr-FR').format(totals.qty)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">
                      {money(totals.revenue)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">
                      {money(totals.purchase)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">
                      {money(totals.profitBefore)}
                    </td>
                    <td className="px-4 py-3" />
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="space-y-3 md:hidden">
              {rows.map((row) => (
                <ProductCard
                  expanded={expandedRows.has(row.productId)}
                  key={row.productId}
                  onToggle={() => toggleRow(row.productId)}
                  onUpdated={handleUpdated}
                  row={row}
                />
              ))}
              <article className="rounded-lg border border-border bg-canvas p-4 text-sm shadow-1">
                <p className="font-semibold">{t('table.total')}</p>
                <dl className="mt-2 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted">{t('table.revenue')}</dt>
                    <dd className="font-mono tabular-nums">{money(totals.revenue)}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted">{t('table.purchase')}</dt>
                    <dd className="font-mono tabular-nums">{money(totals.purchase)}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted">{t('table.profitAfter')}</dt>
                    <dd
                      className={`font-mono tabular-nums ${
                        totals.profitAfter < 0 ? 'text-danger' : 'text-success'
                      }`}
                    >
                      {money(totals.profitAfter)}
                    </dd>
                  </div>
                </dl>
              </article>
            </div>
          </>
        )}
      </section>
    </section>
  );
}
