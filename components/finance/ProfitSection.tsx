'use client';

import type { FinanceReport } from '@/lib/finance/profit';
import { formatMoney } from '@/lib/format/fcfa';
import { useTranslations } from 'next-intl';
import { useCallback } from 'react';

type Props = {
  report: FinanceReport;
  from: string;
  to: string;
};

function formatRate(bps: number): string {
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(bps / 100)} %`;
}

function ProfitRow({
  indent,
  label,
  note,
  value,
  variant,
}: {
  indent?: boolean;
  label: string;
  note?: string;
  value: number;
  variant?: 'muted' | 'bold' | 'positive' | 'negative';
}) {
  const textClass =
    variant === 'muted'
      ? 'text-muted'
      : variant === 'bold'
        ? 'font-semibold text-text'
        : variant === 'positive'
          ? 'font-semibold text-success'
          : variant === 'negative'
            ? 'font-semibold text-danger'
            : 'text-text';

  return (
    <div className={`flex items-baseline justify-between gap-4 py-2 ${indent ? 'pl-4' : ''}`}>
      <div className="min-w-0">
        <span className={`text-sm ${textClass}`}>{label}</span>
        {note ? <span className="ml-2 text-xs text-muted">({note})</span> : null}
      </div>
      <span className={`shrink-0 font-mono text-sm tabular-nums ${textClass}`}>
        {formatMoney(value, 'XOF')}
      </span>
    </div>
  );
}

function Divider() {
  return <div className="border-border border-t" />;
}

export function ProfitSection({ report, from, to }: Props) {
  const t = useTranslations('finance.profit');

  const handleCsvExport = useCallback(() => {
    const rows: string[][] = [
      ['Type', 'Libellé', 'Compte SYSCOHADA', 'Montant (FCFA)'],
      ['Produit', t('netCa'), '706', String(report.netCAMinor)],
      ['Réduction', t('deliveryFees'), '706', String(-report.deliveryFeesMinor)],
      ['Charge', t('netCogs'), '6031', String(report.netCogsMinor)],
      ['Charge', t('mobileMoney'), '627', String(report.mobileMoneyFeesMinor)],
      ...report.expensesByCategory.map((cat) => [
        'Charge',
        cat.label,
        cat.code === 'OTHER' ? '65' : cat.code,
        String(cat.totalMinor),
      ]),
      ['Résultat', t('netProfit'), '12', String(report.netProfitMinor)],
    ];
    const csv = rows
      .map((r) => r.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `teer_resultats_${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [report, from, to, t]);

  const netProfitVariant =
    report.netProfitMinor > 0 ? 'positive' : report.netProfitMinor < 0 ? 'negative' : 'bold';

  const marginEstimated = report.cogsEstimated;

  return (
    <section className="rounded-lg border border-border bg-surface p-5 shadow-1">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="text-base font-semibold text-text">{t('title')}</h2>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${
              marginEstimated
                ? 'bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200'
                : 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200'
            }`}
            title={
              marginEstimated
                ? t('marginEstimatedHint', {
                    amount: formatMoney(report.cogsEstimatedMinor, 'XOF'),
                  })
                : t('marginRealHint')
            }
          >
            {marginEstimated ? t('marginEstimated') : t('marginReal')}
          </span>
          <button
            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-canvas hover:text-text"
            onClick={handleCsvExport}
            type="button"
          >
            {t('csv')}
          </button>
        </div>
      </div>

      <div className="divide-y divide-border">
        <ProfitRow label={t('ca')} value={report.caMinor} />
        {report.deliveryFeesMinor > 0 && (
          <ProfitRow
            indent
            label={t('deliveryFees')}
            value={-report.deliveryFeesMinor}
            variant="muted"
          />
        )}
        {report.returnContraRevenueMinor > 0 && (
          <ProfitRow
            indent
            label={t('returns')}
            value={-report.returnContraRevenueMinor}
            variant="muted"
          />
        )}
        <ProfitRow label={t('netCa')} value={report.netCAMinor} variant="bold" />

        <Divider />

        <ProfitRow label={t('cogs')} value={-report.cogsMinor} variant="muted" />
        {report.returnedCogsReversalMinor > 0 && (
          <ProfitRow
            indent
            label={t('cogsReversal')}
            value={report.returnedCogsReversalMinor}
            variant="muted"
          />
        )}
        <ProfitRow
          label={t('grossMargin')}
          note={formatRate(report.grossMarginBps)}
          value={report.grossMarginMinor}
          variant="bold"
        />
        <p className="pb-2 text-xs text-muted">{t('grossMarginHint')}</p>
        {report.cogsExcludedOrderCount > 0 && (
          <p className="pb-2 text-xs text-amber-700 dark:text-amber-300">
            {t('excludedOrders', { count: report.cogsExcludedOrderCount })}
          </p>
        )}
        {report.cogsUnknownLineCount > 0 && (
          <p className="pb-2 text-xs text-amber-700 dark:text-amber-300">
            {t('blindSpotLines', { count: report.cogsUnknownLineCount })}
          </p>
        )}

        <Divider />

        {report.mobileMoneyFeesMinor > 0 && (
          <ProfitRow
            indent
            label={t('mobileMoney')}
            value={-report.mobileMoneyFeesMinor}
            variant="muted"
          />
        )}
        {report.expensesMinor > 0 && (
          <ProfitRow indent label={t('expenses')} value={-report.expensesMinor} variant="muted" />
        )}

        <Divider />

        <ProfitRow
          label={t('netProfit')}
          note={
            report.netCAMinor > 0
              ? formatRate(Math.round((report.netProfitMinor * 10_000) / report.netCAMinor))
              : undefined
          }
          value={report.netProfitMinor}
          variant={netProfitVariant}
        />
      </div>
    </section>
  );
}
