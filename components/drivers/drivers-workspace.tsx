'use client';

import { PendingSpinner } from '@/components/app-shell/pending-spinner';
import { DriverCashPanel } from '@/components/drivers/driver-cash-panel';
import type {
  DriverCashData,
  DriverPerformanceData,
  DriverStockData,
  SettlementHistoryRow,
} from '@/lib/actions/drivers';
import { formatMoney } from '@/lib/format/fcfa';
import { cn } from '@/lib/utils';
import { Phone } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';

type Period = 'today' | '7j' | '30j';

const PERIODS = ['today', '7j', '30j'] as const;

type DriverRow = { id: string; full_name: string; phone: string; is_active: boolean };

type DriverDetail = {
  cash: DriverCashData;
  history: SettlementHistoryRow[];
  orders: { cod_status: string; id: string; order_number: string | null; total_amount: number }[];
  perf: DriverPerformanceData;
  stock: DriverStockData;
};

type DriversWorkspaceProps = {
  detail: DriverDetail | null;
  drivers: DriverRow[];
  period: Period;
  selected: DriverRow | null;
  selectedId: string | null;
};

function statCard(label: string, value: string, accent?: boolean) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4 shadow-1">
      <p className="text-[13px] font-medium text-muted">{label}</p>
      <p
        className={`mt-2 font-mono text-2xl font-semibold tabular-nums ${accent ? 'text-accent' : ''}`}
      >
        {value}
      </p>
    </section>
  );
}

export function DriversWorkspace({
  detail,
  drivers,
  period,
  selected,
  selectedId,
}: DriversWorkspaceProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pendingSelection, setPendingSelection] = useState<{
    driverId: string;
    period: Period;
  } | null>(null);
  const [isTransitionPending, startTransition] = useTransition();

  const effectiveDriverId = pendingSelection?.driverId ?? selectedId;
  const effectivePeriod = pendingSelection?.period ?? period;
  const isBusy = isTransitionPending || pendingSelection !== null;

  useEffect(() => {
    if (
      pendingSelection !== null &&
      pendingSelection.driverId === selectedId &&
      pendingSelection.period === period
    ) {
      setPendingSelection(null);
    }
  }, [pendingSelection, period, selectedId]);

  function buildNextUrl(nextDriverId: string | null, nextPeriod: Period) {
    const nextParams = new URLSearchParams(searchParams.toString());

    if (nextDriverId) {
      nextParams.set('driver', nextDriverId);
    } else {
      nextParams.delete('driver');
    }

    nextParams.set('period', nextPeriod);

    const query = nextParams.toString();
    return query ? `${pathname}?${query}` : pathname;
  }

  function handleSelectDriver(driverId: string) {
    if (driverId === effectiveDriverId) {
      return;
    }

    setPendingSelection({ driverId, period: effectivePeriod });
    startTransition(() => {
      router.replace(buildNextUrl(driverId, effectivePeriod), { scroll: false });
    });
  }

  function handleSelectPeriod(nextPeriod: Period) {
    if (nextPeriod === effectivePeriod) {
      return;
    }

    const nextDriverId = effectiveDriverId ?? selectedId;

    if (!nextDriverId) {
      return;
    }

    setPendingSelection({ driverId: nextDriverId, period: nextPeriod });
    startTransition(() => {
      router.replace(buildNextUrl(nextDriverId, nextPeriod), { scroll: false });
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
      <nav aria-label="Liste des livreurs" className="space-y-2">
        {drivers.length === 0 ? (
          <p className="text-sm text-muted">
            Aucun livreur. Ajoutez des livreurs dans Paramètres → Équipe.
          </p>
        ) : (
          drivers.map((driver) => {
            const active = driver.id === effectiveDriverId;
            const pending = pendingSelection?.driverId === driver.id;

            return (
              <button
                className={cn(
                  'flex min-h-12 w-full flex-col justify-center rounded-lg border px-4 py-2 text-left transition',
                  active
                    ? 'border-accent bg-surface'
                    : 'border-border bg-surface hover:border-accent/40',
                )}
                aria-pressed={active}
                key={driver.id}
                onClick={() => handleSelectDriver(driver.id)}
                type="button"
              >
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 font-medium">{driver.full_name}</span>
                  <span
                    className={cn(
                      'inline-flex size-3.5 shrink-0 items-center justify-center transition-opacity duration-150',
                      pending ? 'opacity-100' : 'opacity-0',
                    )}
                  >
                    <PendingSpinner className="size-3.5" />
                  </span>
                </span>
                <span className="text-xs text-muted">{driver.phone}</span>
                {!driver.is_active && (
                  <span className="mt-1 w-fit rounded-full bg-canvas px-2 py-0.5 text-[11px] text-muted">
                    Inactif
                  </span>
                )}
              </button>
            );
          })
        )}
      </nav>

      <div
        aria-busy={isBusy ? true : undefined}
        className={cn(
          'relative min-w-0 space-y-8 transition-opacity motion-reduce:transition-none',
          isBusy ? 'pointer-events-none opacity-60' : 'opacity-100',
        )}
        data-testid="driver-detail-panel"
      >
        {isBusy ? (
          <div
            aria-hidden="true"
            className="dashboard-shimmer pointer-events-none absolute inset-0 z-10 rounded-lg opacity-60"
          />
        ) : null}

        {!selected || !detail ? (
          <section className="grid place-items-center rounded-lg border border-border border-dashed bg-surface p-10 text-center text-muted shadow-1">
            <p>Sélectionnez un livreur pour voir son stock, son cash et sa performance.</p>
          </section>
        ) : (
          <div className="space-y-8">
            <header className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-5 shadow-1">
              <div>
                <h2 className="text-2xl font-semibold">{selected.full_name}</h2>
                <p className="flex items-center gap-1.5 text-sm text-muted">
                  <Phone aria-hidden="true" className="size-4" />
                  {selected.phone}
                </p>
              </div>
              <span
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  selected.is_active ? 'bg-success-subtle text-success' : 'bg-canvas text-muted'
                }`}
              >
                {selected.is_active ? 'Actif' : 'Inactif'}
              </span>
            </header>

            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-lg font-semibold">Cash</h3>
                <div className="flex rounded-lg border border-border bg-surface p-1 shadow-1">
                  {PERIODS.map((nextPeriod) => {
                    const active = effectivePeriod === nextPeriod;

                    return (
                      <button
                        className={`grid min-h-11 place-items-center rounded-md px-3 text-sm font-medium md:min-h-9 ${
                          active ? 'bg-accent text-[#111]' : 'text-muted hover:text-text'
                        }`}
                        aria-pressed={active}
                        key={nextPeriod}
                        onClick={() => handleSelectPeriod(nextPeriod)}
                        type="button"
                      >
                        {nextPeriod === 'today'
                          ? "Aujourd'hui"
                          : nextPeriod === '7j'
                            ? '7 jours'
                            : '30 jours'}
                      </button>
                    );
                  })}
                </div>
              </div>
              {/* key={selected.id} : on remonte le panneau au changement de livreur
                  pour réinitialiser son état cash depuis la donnée serveur fraîche. */}
              <DriverCashPanel
                driverId={selected.id}
                initialCash={detail.cash}
                initialHistory={detail.history}
                key={selected.id}
              />
            </section>

            <section className="space-y-3">
              <h3 className="text-lg font-semibold">Stock en main</h3>
              {!detail.stock.ok ? (
                <p className="text-sm text-danger">{detail.stock.message}</p>
              ) : detail.stock.rows.length === 0 ? (
                <p className="text-sm text-muted">Aucun stock en main pour ce livreur.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-surface text-left">
                        <th className="px-4 py-3 font-medium">Produit</th>
                        <th className="px-4 py-3 text-right font-medium">Qté en main</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.stock.rows.map((row) => (
                        <tr className="border-b border-border last:border-0" key={row.productId}>
                          <td className="px-4 py-3">
                            <span className="font-medium">{row.title}</span>
                            {row.sku && <span className="ml-2 text-xs text-muted">{row.sku}</span>}
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums">
                            {row.qtyOnHand}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="space-y-3">
              <h3 className="text-lg font-semibold">Performance</h3>
              {!detail.perf.ok ? (
                <p className="text-sm text-danger">{detail.perf.message}</p>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {statCard('Livrées', String(detail.perf.performance.deliveredCount))}
                  {statCard('Annulées / refusées', String(detail.perf.performance.cancelledCount))}
                  {statCard(
                    'Taux de succès',
                    `${Math.round(detail.perf.performance.successRate * 100)} %`,
                  )}
                  {statCard(
                    'Collecté (net annul.)',
                    formatMoney(detail.perf.performance.collectedNetMinor, 'XOF'),
                  )}
                </div>
              )}
            </section>

            <section className="space-y-3">
              <h3 className="text-lg font-semibold">Commandes assignées</h3>
              {detail.orders.length === 0 ? (
                <p className="text-sm text-muted">Aucune commande assignée.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-surface text-left">
                        <th className="px-4 py-3 font-medium">Commande</th>
                        <th className="px-4 py-3 font-medium">Statut</th>
                        <th className="px-4 py-3 text-right font-medium">Montant</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.orders.map((order) => (
                        <tr className="border-b border-border last:border-0" key={order.id}>
                          <td className="px-4 py-3">
                            <Link
                              className="text-accent hover:underline"
                              href={`/commandes/${order.id}`}
                            >
                              {order.order_number ?? order.id.slice(0, 8)}
                            </Link>
                          </td>
                          <td className="px-4 py-3 text-muted">{order.cod_status}</td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums">
                            {formatMoney(Math.round(order.total_amount), 'XOF')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
