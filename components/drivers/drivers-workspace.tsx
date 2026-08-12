'use client';

import { PendingSpinner } from '@/components/app-shell/pending-spinner';
import { DriverCashPanel } from '@/components/drivers/driver-cash-panel';
import { DriverStockTable } from '@/components/drivers/driver-stock-table';
import { PeriodPicker } from '@/components/period-picker/period-picker';
import { usePeriodParams } from '@/components/period-picker/use-period-params';
import { DefinitionToggle } from '@/components/ui/definition-card';
import { ResourceRow } from '@/components/ui/resource-row';
import type {
  DriverAvailableStockData,
  DriverCashData,
  DriverPerformanceData,
  DriverStockData,
  SettlementHistoryRow,
} from '@/lib/actions/drivers';
import { formatMoney } from '@/lib/format/fcfa';
import { cn } from '@/lib/utils';
import { Phone } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { parseAsString, useQueryStates } from 'nuqs';
import { useEffect, useState, useTransition } from 'react';

type DriverRow = { id: string; full_name: string; phone: string; is_active: boolean };

type DriverDetail = {
  availableStock: DriverAvailableStockData;
  stock: DriverStockData;
  cash: DriverCashData;
  history: SettlementHistoryRow[];
  orders: { cod_status: string; id: string; order_number: string | null; total_amount: number }[];
  perf: DriverPerformanceData;
  products: { id: string; sku: string | null; title: string }[];
};

type DriversWorkspaceProps = {
  detail: DriverDetail | null;
  drivers: DriverRow[];
  periodKey: string;
  selected: DriverRow | null;
  selectedId: string | null;
  storeId: string;
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
  periodKey,
  selected,
  selectedId,
  storeId,
}: DriversWorkspaceProps) {
  const t = useTranslations('livreurs.stock');
  const [pendingDriverId, setPendingDriverId] = useState<string | null>(null);
  const [isDriverTransitionPending, startDriverTransition] = useTransition();
  // Seule source d'écriture URL pour `driver` (nuqs) : merge en place, ne touche
  // jamais period/from/to (écrits séparément par <PeriodPicker>, même mécanisme).
  const [, setDriverParams] = useQueryStates(
    { driver: parseAsString },
    { history: 'push', shallow: false, scroll: false, startTransition: startDriverTransition },
  );
  const { isPending: isPeriodPending } = usePeriodParams();

  const effectiveDriverId = pendingDriverId ?? selectedId;
  const isBusy = isDriverTransitionPending || pendingDriverId !== null || isPeriodPending;

  useEffect(() => {
    if (pendingDriverId !== null && pendingDriverId === selectedId) {
      setPendingDriverId(null);
    }
  }, [pendingDriverId, selectedId]);

  function handleSelectDriver(driverId: string) {
    if (driverId === effectiveDriverId) {
      return;
    }

    setPendingDriverId(driverId);
    void setDriverParams({ driver: driverId });
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
            const pending = pendingDriverId === driver.id;

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
              <div className="flex flex-wrap items-center gap-3">
                <span
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    selected.is_active ? 'bg-success-subtle text-success' : 'bg-canvas text-muted'
                  }`}
                >
                  {selected.is_active ? 'Actif' : 'Inactif'}
                </span>
                {/* Un seul PeriodPicker en haut du panneau, avant toutes les cards : il
                    scope Cash (collecté/frais), Performance ET Commandes assignées.
                    Cash chez le livreur / Écart non résolu restent all-time (solde de
                    réconciliation, jamais périodique) et Stock disponible est un instantané
                    (non historisable) — les deux sont volontairement hors filtre. */}
                <PeriodPicker align="end" />
              </div>
            </header>

            <section className="space-y-3">
              <h3 className="text-lg font-semibold">Cash</h3>
              {/* key inclut livreur + périodKey (prop SERVEUR, pas usePeriodParams() —
                  ce hook reflète l'état nuqs optimiste, mis à jour AVANT que le RSC
                  n'ait fini de refetch ; remonter sur ce signal capture encore le
                  prop `detail.cash` périmé dans le useState initial. periodKey ne
                  change qu'une fois le serveur confirmé → remount avec la valeur
                  fraîche garantie. Collecté/frais sont scopés à la période
                  (getDriverCashConsolidation). */}
              <DriverCashPanel
                driverId={selected.id}
                initialCash={detail.cash}
                initialHistory={detail.history}
                key={`${selected.id}-${periodKey}`}
              />
            </section>

            <section className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-lg font-semibold">{t('title')}</h3>
                <DefinitionToggle definition={t('definition')} />
              </div>
              <p className="text-xs text-muted">{t('centralNote')}</p>
              {!detail.stock.ok ? (
                <p className="text-sm text-danger">{detail.stock.message}</p>
              ) : !detail.availableStock.ok ? (
                <p className="text-sm text-danger">{detail.availableStock.message}</p>
              ) : (
                <DriverStockTable
                  availableRows={detail.availableStock.rows}
                  driverId={selected.id}
                  physicalRows={detail.stock.rows}
                  products={detail.products}
                />
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
                <>
                  <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
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
                                href={`/s/${storeId}/commandes/${order.id}`}
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
                  <div className="overflow-hidden rounded-lg border border-border bg-surface md:hidden">
                    {detail.orders.map((order) => (
                      <ResourceRow
                        href={`/s/${storeId}/commandes/${order.id}`}
                        key={order.id}
                        meta={order.cod_status}
                        primaryAction={
                          <span className="font-mono text-sm tabular-nums">
                            {formatMoney(Math.round(order.total_amount), 'XOF')}
                          </span>
                        }
                        title={order.order_number ?? order.id.slice(0, 8)}
                      />
                    ))}
                  </div>
                </>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
