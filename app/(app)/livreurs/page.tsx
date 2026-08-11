import { DriversWorkspace } from '@/components/drivers/drivers-workspace';
import { SettlementHistoryTable } from '@/components/drivers/settlement-history';
import {
  type DriverAvailableStockData,
  type DriverCashData,
  type DriverPerformanceData,
  type DriverStockData,
  type SettlementHistoryRow,
  getAllSettlementHistory,
  getDriverAvailableStock,
  getDriverCashConsolidation,
  getDriverPerformance,
  getDriverSettlementHistory,
  getDriverStockOnHand,
} from '@/lib/actions/drivers';
import { PERIOD_PRESETS, resolvePeriodRange } from '@/lib/periods/date-range';
import { writePcdAccessAudit } from '@/lib/security/pcd-access-audit';
import type { Database } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { LockKeyhole } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

type LivreursPageProps = {
  searchParams: Promise<{ driver?: string; from?: string; period?: string; to?: string }>;
};

type DriverRow = { id: string; full_name: string; phone: string; is_active: boolean };

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
  try {
    await writePcdAccessAudit(supabase as unknown as SupabaseClient<Database>, {
      tenantId: merchantAccountId,
      actorKind: 'human',
      action: 'list_access',
      dataCategory: 'member_data',
      purpose: 'delivery_execution',
      outcome: 'succeeded',
      resourceType: 'driver',
      surface: 'server_component',
      metadata: { result_count: Math.min(drivers.length, 500), page_size: 500 },
    });
  } catch {
    throw new Error('pcd_access_audit_unavailable');
  }
  const selectedId =
    params.driver && drivers.some((d) => d.id === params.driver) ? params.driver : null;
  const selected = drivers.find((d) => d.id === selectedId) ?? null;

  let detail: {
    availableStock: DriverAvailableStockData;
    stock: DriverStockData;
    cash: DriverCashData;
    history: SettlementHistoryRow[];
    perf: DriverPerformanceData;
    products: { id: string; title: string; sku: string | null }[];
    orders: { id: string; order_number: string | null; cod_status: string; total_amount: number }[];
  } | null = null;

  if (selected) {
    const { from, to } = resolvePeriodRange({
      allowedPresets: PERIOD_PRESETS,
      defaultPreset: '30j',
      from: params.from,
      period: params.period,
      to: params.to,
    });
    const range = { from: from.toISOString(), to: to.toISOString() };
    const [availableStock, stock, cash, history, perf, productsResult, ordersResult] =
      await Promise.all([
        getDriverAvailableStock(selected.id),
        getDriverStockOnHand(selected.id),
        getDriverCashConsolidation(selected.id, range),
        getDriverSettlementHistory(selected.id),
        getDriverPerformance(selected.id, range),
        // is_bundle=false : un bundle n'est jamais chargeable directement sur
        // un livreur (PR 1, driver_stock_set rejeté en DB pour un bundle,
        // migration 0108) — l'exclure ici évite d'offrir dans "+ Ajouter un
        // produit" une action qui échouerait systématiquement côté serveur.
        supabase
          .from('product')
          .select('id, title, sku')
          .eq('merchant_account_id', merchantAccountId)
          .eq('is_active', true)
          .eq('is_bundle', false)
          .order('title'),
        supabase
          .from('orders')
          .select('id, order_number, cod_status, total_amount')
          .eq('merchant_account_id', merchantAccountId)
          .eq('assigned_driver_id', selected.id)
          .gte('created_at', range.from)
          .lt('created_at', range.to)
          .order('updated_at', { ascending: false })
          .limit(50),
      ]);

    detail = {
      availableStock,
      stock,
      cash,
      history: history.ok ? history.rows : [],
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
        periodKey={`${params.period ?? ''}|${params.from ?? ''}|${params.to ?? ''}`}
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
