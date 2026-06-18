'use client';

import type { FinanceProductCostReport, FinanceProductCostRow } from '@/lib/finance/product-cost';
import { formatMoney } from '@/lib/format/fcfa';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Fragment, useState } from 'react';

type Props = {
  from: string;
  report: FinanceProductCostReport;
  to: string;
};

function money(value: number): string {
  return formatMoney(value, 'XOF');
}

function DefinitionCard({
  definition,
  formula,
  label,
  value,
}: {
  definition: string;
  formula: string;
  label: string;
  value: number;
}) {
  const t = useTranslations('finance.products.cards');
  const [expanded, setExpanded] = useState(false);

  return (
    <button
      aria-expanded={expanded}
      className="group rounded-lg border border-border bg-surface p-4 text-left shadow-1 transition hover:-translate-y-0.5 hover:shadow-2"
      onClick={() => setExpanded((current) => !current)}
      type="button"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[13px] font-medium text-muted">{label}</p>
          <p className="mt-2 font-mono text-2xl font-semibold tabular-nums">{money(value)}</p>
        </div>
        <span className="rounded-full border border-border px-2 py-1 text-[11px] font-medium text-muted">
          {expanded ? t('expanded') : t('collapsed')}
        </span>
      </div>

      {expanded ? (
        <div className="mt-3 rounded-md border border-border bg-canvas p-3">
          <p className="text-sm text-text">{definition}</p>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs leading-5 text-muted">
            {formula}
          </pre>
        </div>
      ) : null}
    </button>
  );
}

function CostMissingBadge() {
  const t = useTranslations('finance.products.table');
  return (
    <span
      className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
      title={t('costMissingHint')}
    >
      {t('costMissing')}
    </span>
  );
}

function LowVolumeBadge() {
  const t = useTranslations('finance.products.table');
  return (
    <span
      className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950/30 dark:text-amber-300"
      title={t('lowVolumeHint')}
    >
      {t('lowVolume')}
    </span>
  );
}

function ProfitCell({ row, value }: { row: FinanceProductCostRow; value: number }) {
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
          <ProfitCell row={row} value={row.profitAfterMinor} />
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

export function FinanceProductCostView({ from, report, to }: Props) {
  const t = useTranslations('finance.products');
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

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
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              className="min-h-11 rounded-md border border-border px-4 py-2 text-sm font-medium text-muted hover:bg-canvas hover:text-text"
              href="/finances?tab=global#depenses"
            >
              {t('editExpenses')}
            </Link>
            <Link
              className="min-h-11 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-text hover:bg-accent-hover"
              href="/commandes"
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
            value={report.totalPurchasePriceMinor}
          />
          <DefinitionCard
            definition={t('cards.totalCost.definition')}
            formula={t('cards.totalCost.formula')}
            label={t('cards.totalCost.label')}
            value={report.totalCostMinor}
          />
          <DefinitionCard
            definition={t('cards.profitAfter.definition')}
            formula={t('cards.profitAfter.formula')}
            label={t('cards.profitAfter.label')}
            value={report.totalProfitAfterMinor}
          />
        </div>

        {report.unallocatedDeliveryMinor > 0 ? (
          <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">
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
              products: new Intl.NumberFormat('fr-FR').format(report.productCount),
              profit: money(report.totalProfitAfterMinor),
            })}
          </p>
        </div>

        {report.rows.length === 0 ? (
          <p className="text-sm text-muted">{t('empty')}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
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
                {report.rows.map((row) => {
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
                          {row.costMissing ? <CostMissingBadge /> : money(row.purchasePriceMinor)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums">
                          <ProfitCell row={row} value={row.profitBeforeMinor} />
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            aria-expanded={expanded}
                            className="min-h-11 rounded-md border border-border px-3 text-xs font-medium text-muted hover:bg-canvas hover:text-text"
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
                    {new Intl.NumberFormat('fr-FR').format(report.totalQtySold)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">
                    {money(report.totalRevenueMinor)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">
                    {money(report.totalPurchasePriceMinor)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">
                    {money(report.totalProfitBeforeMinor)}
                  </td>
                  <td className="px-4 py-3" />
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}
