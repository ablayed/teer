import type { FinanceDriverCostReport } from '@/lib/finance/driver-cost';
import { formatMoney } from '@/lib/format/fcfa';
import { getTranslations } from 'next-intl/server';

type Props = {
  from: string;
  report: FinanceDriverCostReport;
  to: string;
};

export async function FinanceDriverCostView({ from, report, to }: Props) {
  const t = await getTranslations('finance.driverCost');
  const totalAverageUnitCogs =
    report.totalQtySold > 0 ? Math.round(report.totalCogsMinor / report.totalQtySold) : 0;

  return (
    <section className="space-y-5">
      <header className="rounded-lg border border-border bg-surface p-5 shadow-1">
        <div className="space-y-2">
          <h2 className="text-2xl font-semibold text-text">{t('title')}</h2>
          <p className="max-w-3xl text-sm text-muted">{t('subtitle')}</p>
          <p className="text-xs text-muted">{t('period', { from, to })}</p>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <section className="rounded-lg border border-border bg-canvas p-4">
            <p className="text-[13px] font-medium text-muted">{t('cards.cogs')}</p>
            <p className="mt-2 font-mono text-2xl font-semibold tabular-nums">
              {formatMoney(report.totalCogsMinor, 'XOF')}
            </p>
            <p className="mt-2 text-sm text-muted">{t('cards.cogsHint')}</p>
          </section>
          <section className="rounded-lg border border-border bg-canvas p-4">
            <p className="text-[13px] font-medium text-muted">{t('cards.qty')}</p>
            <p className="mt-2 font-mono text-2xl font-semibold tabular-nums">
              {new Intl.NumberFormat('fr-FR').format(report.totalQtySold)}
            </p>
            <p className="mt-2 text-sm text-muted">{t('cards.qtyHint')}</p>
          </section>
          <section className="rounded-lg border border-border bg-canvas p-4">
            <p className="text-[13px] font-medium text-muted">{t('cards.unit')}</p>
            <p className="mt-2 font-mono text-2xl font-semibold tabular-nums">
              {formatMoney(totalAverageUnitCogs, 'XOF')}
            </p>
            <p className="mt-2 text-sm text-muted">{t('cards.unitHint')}</p>
          </section>
        </div>
      </header>

      <section className="rounded-lg border border-border bg-surface p-5 shadow-1">
        <div className="mb-4 flex flex-col gap-1 md:flex-row md:items-end md:justify-between">
          <div>
            <h3 className="text-lg font-semibold">{t('table.title')}</h3>
            <p className="text-sm text-muted">{t('table.subtitle')}</p>
          </div>
          {report.totalRevenueMinor > 0 ? (
            <p className="text-sm text-muted">
              {t('table.context', {
                revenue: formatMoney(report.totalRevenueMinor, 'XOF'),
              })}
            </p>
          ) : null}
        </div>

        {report.rows.length === 0 ? (
          <p className="text-sm text-muted">{t('empty')}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-canvas text-left">
                  <th className="px-4 py-3 font-medium">{t('table.driver')}</th>
                  <th className="px-4 py-3 text-right font-medium">{t('table.qty')}</th>
                  <th className="px-4 py-3 text-right font-medium">{t('table.cogs')}</th>
                  {report.totalRevenueMinor > 0 ? (
                    <th className="px-4 py-3 text-right font-medium">{t('table.revenue')}</th>
                  ) : null}
                  {report.totalRevenueMinor > 0 ? (
                    <th className="px-4 py-3 text-right font-medium">{t('table.margin')}</th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => (
                  <tr className="border-b border-border last:border-0" key={row.driverId}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-text">{row.title}</p>
                      <p className="text-xs text-muted">{row.driverId.slice(0, 8)}</p>
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">
                      {new Intl.NumberFormat('fr-FR').format(row.qtySold)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">
                      {formatMoney(row.cogsMinor, 'XOF')}
                    </td>
                    {report.totalRevenueMinor > 0 ? (
                      <td className="px-4 py-3 text-right font-mono tabular-nums">
                        {formatMoney(row.revenueMinor ?? 0, 'XOF')}
                      </td>
                    ) : null}
                    {report.totalRevenueMinor > 0 ? (
                      <td
                        className={`px-4 py-3 text-right font-mono tabular-nums ${
                          (row.marginMinor ?? 0) < 0 ? 'text-danger' : 'text-success'
                        }`}
                      >
                        {formatMoney(row.marginMinor ?? 0, 'XOF')}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}
