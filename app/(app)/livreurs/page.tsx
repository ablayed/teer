import { DriverLotForm } from '@/components/drivers/driver-lot-form';
import { DriverRemittanceForm } from '@/components/drivers/driver-remittance-form';
import {
  getDriverCashConsolidation,
  getDriverPerformance,
  getDriverStockOnHand,
} from '@/lib/actions/drivers';
import { formatMoney } from '@/lib/format/fcfa';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { LockKeyhole, Phone } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

type LivreursPageProps = {
  searchParams: Promise<{ driver?: string; period?: string }>;
};

type DriverRow = { id: string; full_name: string; phone: string; is_active: boolean };

const PERIODS = ['today', '7j', '30j'] as const;
type Period = (typeof PERIODS)[number];

function periodRange(period: Period): { from: string; to: string } {
  const now = new Date();
  const to = now;
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  if (period === '7j') from.setDate(from.getDate() - 6);
  else if (period === '30j') from.setDate(from.getDate() - 29);
  return { from: from.toISOString(), to: to.toISOString() };
}

async function getCurrentMember() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { merchantAccountId: null, role: null, supabase };

  const { data: member } = await supabase
    .from('merchant_member')
    .select('merchant_account_id, role')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();

  const currentMember = member as { merchant_account_id: string; role: string } | null;

  return {
    merchantAccountId: currentMember?.merchant_account_id ?? null,
    role: currentMember?.role ?? null,
    supabase,
  };
}

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

export default async function LivreursPage({ searchParams }: LivreursPageProps) {
  const nav = await getTranslations('nav');
  const params = await searchParams;
  const { merchantAccountId, role, supabase } = await getCurrentMember();

  if (!merchantAccountId || (role !== 'owner' && role !== 'manager')) {
    return (
      <main className="space-y-6" id="main">
        <h1 className="font-display text-4xl md:text-5xl">{nav('livreurs')}</h1>
        <section className="flex max-w-2xl gap-3 rounded-lg border border-border bg-surface p-5 text-muted shadow-1">
          <LockKeyhole aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <p>Cette section est réservée au propriétaire et aux managers.</p>
        </section>
      </main>
    );
  }

  const { data: driversData } = await supabase
    .from('driver')
    .select('id, full_name, phone, is_active')
    .eq('merchant_account_id', merchantAccountId)
    .order('is_active', { ascending: false })
    .order('full_name');

  const drivers = (driversData ?? []) as DriverRow[];
  const period: Period = PERIODS.includes(params.period as Period)
    ? (params.period as Period)
    : '30j';
  const selectedId =
    params.driver && drivers.some((d) => d.id === params.driver) ? params.driver : null;
  const selected = drivers.find((d) => d.id === selectedId) ?? null;

  let detail: {
    stock: Awaited<ReturnType<typeof getDriverStockOnHand>>;
    cash: Awaited<ReturnType<typeof getDriverCashConsolidation>>;
    perf: Awaited<ReturnType<typeof getDriverPerformance>>;
    products: { id: string; title: string; sku: string | null }[];
    orders: { id: string; order_number: string | null; cod_status: string; total_amount: number }[];
  } | null = null;

  if (selected) {
    const range = periodRange(period);
    const [stock, cash, perf, productsResult, ordersResult] = await Promise.all([
      getDriverStockOnHand(selected.id),
      getDriverCashConsolidation(selected.id),
      getDriverPerformance(selected.id, range),
      supabase
        .from('product')
        .select('id, title, sku')
        .eq('merchant_account_id', merchantAccountId)
        .eq('is_active', true)
        .order('title'),
      supabase
        .from('orders')
        .select('id, order_number, cod_status, total_amount')
        .eq('merchant_account_id', merchantAccountId)
        .eq('assigned_driver_id', selected.id)
        .order('updated_at', { ascending: false })
        .limit(50),
    ]);

    detail = {
      stock,
      cash,
      perf,
      products: (productsResult.data ?? []) as { id: string; title: string; sku: string | null }[],
      orders: (ordersResult.data ?? []) as {
        id: string;
        order_number: string | null;
        cod_status: string;
        total_amount: number;
      }[],
    };
  }

  return (
    <main className="space-y-6" id="main">
      <header className="space-y-2">
        <h1 className="font-display text-4xl md:text-5xl">{nav('livreurs')}</h1>
        <p className="max-w-2xl text-muted">
          Stock en main, cash dû/collecté/remis et performance par livreur.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <nav aria-label="Liste des livreurs" className="space-y-2">
          {drivers.length === 0 ? (
            <p className="text-sm text-muted">
              Aucun livreur. Ajoutez des livreurs dans Paramètres → Équipe.
            </p>
          ) : (
            drivers.map((driver) => {
              const active = driver.id === selectedId;
              return (
                <Link
                  className={`flex min-h-12 flex-col justify-center rounded-lg border px-4 py-2 transition ${
                    active
                      ? 'border-accent bg-surface'
                      : 'border-border bg-surface hover:border-accent/40'
                  }`}
                  href={`/livreurs?driver=${driver.id}&period=${period}`}
                  key={driver.id}
                >
                  <span className="font-medium">{driver.full_name}</span>
                  <span className="text-xs text-muted">{driver.phone}</span>
                  {!driver.is_active && (
                    <span className="mt-1 w-fit rounded-full bg-canvas px-2 py-0.5 text-[11px] text-muted">
                      Inactif
                    </span>
                  )}
                </Link>
              );
            })
          )}
        </nav>

        {!selected || !detail ? (
          <section className="grid place-items-center rounded-lg border border-border border-dashed bg-surface p-10 text-center text-muted">
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

            {/* Cash consolidé */}
            <section className="space-y-3">
              <h3 className="text-lg font-semibold">Cash</h3>
              {!detail.cash.ok ? (
                <p className="text-sm text-danger">{detail.cash.message}</p>
              ) : (
                <>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    {statCard(
                      'Dû / attendu',
                      formatMoney(detail.cash.consolidation.expectedMinor, 'XOF'),
                    )}
                    {statCard(
                      'Collecté',
                      formatMoney(detail.cash.consolidation.collectedMinor, 'XOF'),
                    )}
                    {statCard('Remis', formatMoney(detail.cash.consolidation.remittedMinor, 'XOF'))}
                    {statCard(
                      'Cash chez le livreur',
                      formatMoney(detail.cash.consolidation.cashOnHandMinor, 'XOF'),
                      true,
                    )}
                  </div>
                  {detail.cash.consolidation.discrepancyMinor > 0 && (
                    <p className="text-sm font-medium text-danger">
                      Écart non résolu :{' '}
                      {formatMoney(detail.cash.consolidation.discrepancyMinor, 'XOF')}
                    </p>
                  )}
                  <div className="rounded-lg border border-border bg-surface p-4 shadow-1">
                    <p className="mb-3 text-sm font-medium">
                      Enregistrer un versement (remise globale)
                    </p>
                    <DriverRemittanceForm driverId={selected.id} />
                  </div>
                </>
              )}
            </section>

            {/* Stock en main */}
            <section className="space-y-3">
              <h3 className="text-lg font-semibold">Stock en main</h3>
              <div className="rounded-lg border border-border bg-surface p-4 shadow-1">
                <DriverLotForm driverId={selected.id} products={detail.products} />
              </div>
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

            {/* Performance */}
            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-lg font-semibold">Performance</h3>
                <div className="flex rounded-lg border border-border bg-surface p-1 shadow-1">
                  {PERIODS.map((p) => (
                    <Link
                      className={`grid min-h-9 place-items-center rounded-md px-3 text-sm font-medium ${
                        period === p ? 'bg-accent text-[#111]' : 'text-muted hover:text-text'
                      }`}
                      href={`/livreurs?driver=${selected.id}&period=${p}`}
                      key={p}
                    >
                      {p === 'today' ? "Aujourd'hui" : p === '7j' ? '7 jours' : '30 jours'}
                    </Link>
                  ))}
                </div>
              </div>
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

            {/* Commandes assignées */}
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
    </main>
  );
}
