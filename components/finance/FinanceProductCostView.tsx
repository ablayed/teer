'use client';

import type { FinanceProductCostReport } from '@/lib/finance/product-cost';
import { formatMoney } from '@/lib/format/fcfa';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';

type Props = {
  from: string;
  report: FinanceProductCostReport;
  to: string;
};

function MetricCard({
  detail,
  expandedLabel,
  formula,
  hint,
  label,
  value,
}: {
  detail: string;
  expandedLabel: string;
  formula: string;
  hint: string;
  label: string;
  value: number;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <button
      className="group rounded-lg border border-border bg-surface p-4 text-left shadow-1 transition hover:-translate-y-0.5 hover:shadow-2"
      onClick={() => setExpanded((current) => !current)}
      title={hint}
      type="button"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[13px] font-medium text-muted">{label}</p>
          <p className="mt-2 font-mono text-2xl font-semibold tabular-nums">
            {formatMoney(value, 'XOF')}
          </p>
        </div>
        <span className="rounded-full border border-border px-2 py-1 text-[11px] font-medium text-muted">
          {expanded ? expandedLabel : detail}
        </span>
      </div>

      <p className="mt-3 text-sm text-muted">{detail}</p>
      {expanded ? (
        <div className="mt-3 rounded-md border border-border bg-canvas p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs leading-5 text-text">
            {formula}
          </pre>
        </div>
      ) : null}
    </button>
  );
}

export function FinanceProductCostView({ from, report, to }: Props) {
  const t = useTranslations('finance.products');

  const avgPilotUnitCost =
    report.totalQtySold > 0 ? Math.round(report.totalPilotCostMinor / report.totalQtySold) : 0;
  const avgOfficialUnitCost =
    report.totalQtySold > 0 ? Math.round(report.totalOfficialCogsMinor / report.totalQtySold) : 0;

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
          <MetricCard
            detail={t('cards.ads.detail')}
            expandedLabel={t('cards.expanded')}
            formula={t('cards.ads.formula', {
              ads: formatMoney(report.adsTotalMinor, 'XOF'),
              revenue: formatMoney(report.totalRevenueMinor, 'XOF'),
            })}
            hint={t('cards.ads.hint')}
            label={t('cards.ads.label')}
            value={report.totalAdsAllocatedMinor}
          />
          <MetricCard
            detail={t('cards.delivery.detail')}
            expandedLabel={t('cards.expanded')}
            formula={t('cards.delivery.formula', {
              delivery: formatMoney(report.deliveryAllocatedMinor, 'XOF'),
              units: new Intl.NumberFormat('fr-FR').format(report.matchedUnitCount),
            })}
            hint={t('cards.delivery.hint')}
            label={t('cards.delivery.label')}
            value={report.deliveryAllocatedMinor}
          />
          <MetricCard
            detail={t('cards.pilot.detail')}
            expandedLabel={t('cards.expanded')}
            formula={t('cards.pilot.formula', {
              ads: formatMoney(report.totalAdsAllocatedMinor, 'XOF'),
              delivery: formatMoney(report.deliveryAllocatedMinor, 'XOF'),
              landed: formatMoney(report.totalLandedReceivedMinor, 'XOF'),
              qty: new Intl.NumberFormat('fr-FR').format(report.totalQtySold),
            })}
            hint={t('cards.pilot.hint')}
            label={t('cards.pilot.label')}
            value={avgPilotUnitCost}
          />
        </div>

        {report.unallocatedDeliveryMinor > 0 ? (
          <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">
            {t('unallocatedDelivery', {
              amount: formatMoney(report.unallocatedDeliveryMinor, 'XOF'),
            })}
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
              margin: formatMoney(report.totalMarginMinor, 'XOF'),
              products: new Intl.NumberFormat('fr-FR').format(report.productCount),
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
                  <th className="px-4 py-3 text-right font-medium">{t('table.officialUnit')}</th>
                  <th className="px-4 py-3 text-right font-medium">{t('table.pilotUnit')}</th>
                  <th className="px-4 py-3 text-right font-medium">{t('table.margin')}</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => (
                  <tr className="border-b border-border last:border-0" key={row.productId}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-text">{row.title}</p>
                      <p className="text-xs text-muted">{row.productId.slice(0, 8)}</p>
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">
                      {new Intl.NumberFormat('fr-FR').format(row.qtySold)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">
                      {formatMoney(row.revenueMinor, 'XOF')}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">
                      {formatMoney(row.officialUnitCostMinor, 'XOF')}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">
                      {formatMoney(row.pilotUnitCostMinor, 'XOF')}
                    </td>
                    <td
                      className={`px-4 py-3 text-right font-mono tabular-nums ${
                        row.marginMinor < 0 ? 'text-danger' : 'text-success'
                      }`}
                    >
                      {formatMoney(row.marginMinor, 'XOF')}
                    </td>
                  </tr>
                ))}
                <tr className="bg-canvas/70 font-semibold">
                  <td className="px-4 py-3">{t('table.total')}</td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">
                    {new Intl.NumberFormat('fr-FR').format(report.totalQtySold)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">
                    {formatMoney(report.totalRevenueMinor, 'XOF')}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">
                    {formatMoney(avgOfficialUnitCost, 'XOF')}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">
                    {formatMoney(avgPilotUnitCost, 'XOF')}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">
                    {formatMoney(report.totalMarginMinor, 'XOF')}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}
