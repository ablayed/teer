import { DriversWorkspace } from '@/components/drivers/drivers-workspace';
import { SettlementHistoryTable } from '@/components/drivers/settlement-history';
import {
  type DriverCashData,
  type DriverPerformanceData,
  type DriverStockData,
  type SettlementHistoryRow,
  getAllSettlementHistory,
  getDriverCashConsolidation,
  getDriverPerformance,
  getDriverSettlementHistory,
  getDriverStockOnHand,
} from '@/lib/actions/drivers';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { LockKeyhole } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

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
    stock: DriverStockData;
    cash: DriverCashData;
    history: SettlementHistoryRow[];
    perf: DriverPerformanceData;
    orders: { id: string; order_number: string | null; cod_status: string; total_amount: number }[];
  } | null = null;

  if (selected) {
    const range = periodRange(period);
    const [stock, cash, history, perf, ordersResult] = await Promise.all([
      getDriverStockOnHand(selected.id),
      getDriverCashConsolidation(selected.id),
      getDriverSettlementHistory(selected.id),
      getDriverPerformance(selected.id, range),
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
      history: history.ok ? history.rows : [],
      perf,
      orders: (ordersResult.data ?? []) as {
        id: string;
        order_number: string | null;
        cod_status: string;
        total_amount: number;
      }[],
    };
  }

  const globalHistory = await getAllSettlementHistory();

  return (
    <main className="space-y-6" id="main">
      <header className="space-y-2">
        <h1 className="font-display text-4xl md:text-5xl">{nav('livreurs')}</h1>
        <p className="max-w-2xl text-muted">
          Stock en main, cash dû/collecté/remis et performance par livreur.
        </p>
      </header>

      <DriversWorkspace
        detail={detail}
        drivers={drivers}
        period={period}
        selected={selected}
        selectedId={selectedId}
      />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Versements globaux</h2>
        <p className="text-sm text-muted">
          Tous les versements enregistrés, tous livreurs confondus, du plus récent au plus ancien.
        </p>
        <SettlementHistoryTable
          emptyLabel="Aucun versement enregistré pour le moment."
          rows={globalHistory.ok ? globalHistory.rows : []}
          showDriver
        />
      </section>
    </main>
  );
}
