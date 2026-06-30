import { NewOrderForm } from '@/components/orders/new-order-form';
import { OrdersBoardProvider } from '@/components/orders/orders-board-context';
import { OrdersWorkspace } from '@/components/orders/orders-workspace';
import { SyncOrdersButton } from '@/components/orders/sync-orders-button';
import { ShopFilterSelector } from '@/components/shops/shop-filter-selector';
import { EmptyState } from '@/components/ui/empty-state';
import { PeriodControls } from '@/components/ui/period-controls';
import { getActiveDrivers } from '@/lib/actions/drivers';
import { getMerchantAccount, getMerchantMemberForUser } from '@/lib/actions/merchant';
import { getOrdersPageData } from '@/lib/actions/orders';
import { getProductCatalogPageData } from '@/lib/actions/products';
import { getShopConnection } from '@/lib/actions/shopify';
import { orderSavedViews } from '@/lib/domain/order-saved-views';
import { normalizeOrderSearch } from '@/lib/orders/search';
import { resolvePeriodRange } from '@/lib/periods/date-range';
import { listShopFilterOptions, normalizeShopParam } from '@/lib/shops/shop-filter';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AlertCircle, ArrowRight, Store } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

type CommandesPageProps = {
  searchParams: Promise<{
    from?: string;
    period?: string;
    q?: string;
    shop?: string;
    vue?: string;
    sync_error?: string;
    synced?: string;
    to?: string;
  }>;
};

const syncErrorCodes = ['no_shop', 'sync_failed', 'token_error'] as const;
type SyncErrorCode = (typeof syncErrorCodes)[number];

function isSyncErrorCode(value: string): value is SyncErrorCode {
  return syncErrorCodes.includes(value as SyncErrorCode);
}

// Phase 11 : la réassignation inline dans la liste est réservée owner/manager
// (le serveur le ré-impose via requireRole sur reassignOrderDriverAction).
async function canReassignDrivers(): Promise<boolean> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return false;
  }
  const member = await getMerchantMemberForUser(user.id);
  return member?.role === 'owner' || member?.role === 'manager';
}

export default async function CommandesPage({ searchParams }: CommandesPageProps) {
  const t = await getTranslations('orders');
  const clientsT = await getTranslations('clients');
  const params = await searchParams;
  const search = normalizeOrderSearch(params.q);
  const { activePeriod, from, to } = resolvePeriodRange({
    allowedPresets: ['today', 'yesterday', '7j', '30j'],
    defaultPreset: '30j',
    from: params.from,
    period: params.period,
    to: params.to,
  });
  const [shopConnection, merchant, productCatalog, drivers, canReassign] = await Promise.all([
    getShopConnection(),
    getMerchantAccount(),
    getProductCatalogPageData(),
    getActiveDrivers(),
    canReassignDrivers(),
  ]);
  const shops = merchant
    ? await listShopFilterOptions(await createSupabaseServerClient(), merchant.id)
    : [];
  const selectedShopId = normalizeShopParam(params.shop, shops);
  const [pageData] = await Promise.all([
    getOrdersPageData({
      dateFrom: from.toISOString(),
      dateTo: to.toISOString(),
      search,
      shopId: selectedShopId,
      view: params.vue,
    }),
  ]);
  const activeView = pageData.activeView;
  const productOptions = productCatalog.ok
    ? productCatalog.products
        .filter((product) => product.is_active)
        .map((product) => ({
          id: product.id,
          sku: product.sku,
          title: product.title,
        }))
    : [];

  // Phase 13 : la création manuelle demande la boutique quand le marchand en a
  // plusieurs (sinon rattachement automatique à l'unique boutique).
  const shopOptions = shops;

  const viewCounts = orderSavedViews.map((view) => ({
    id: view.id,
    label: view.label,
    count: pageData.viewCounts[view.id],
  }));
  const reliabilityLabels = {
    new: clientsT('tiers.new'),
    reliable: clientsT('tiers.reliable'),
    risk: clientsT('tiers.risk'),
    watch: clientsT('tiers.watch'),
  };
  const searchedTotal = pageData.viewCounts.toutes;
  const totalOrders = pageData.totalCount;
  const visibleCount = pageData.viewCounts[activeView];
  const syncedCount = params.synced ? Number.parseInt(params.synced, 10) : null;
  const syncError =
    params.sync_error && isSyncErrorCode(params.sync_error) ? params.sync_error : null;
  const showNoShop = totalOrders === 0 && !shopConnection;
  const showNoOrdersWithShop = totalOrders === 0 && shopConnection;
  // L'état vide « aucun résultat pour la recherche » est désormais géré côté client par
  // OrdersPageLoader : la recherche met l'URL à jour en shallow (history.replaceState), donc
  // ce RSC ne se re-rend pas par recherche. On ne garde ici que les états non liés à `?q=`.
  const showFilteredEmpty = searchedTotal > 0 && visibleCount === 0 && search.length === 0;
  const showWorkspace = totalOrders > 0;

  return (
    <OrdersBoardProvider>
      <main className="space-y-6" id="main">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="space-y-2">
            <h1 className="font-display text-4xl md:text-5xl">{t('title')}</h1>
            <p className="max-w-2xl text-muted">{t('subtitle')}</p>
          </div>
          <div className="flex flex-col gap-3 sm:items-end">
            <NewOrderForm products={productOptions} shops={shopOptions} />
            <SyncOrdersButton hasShop={Boolean(shopConnection)} />
          </div>
        </div>

        {syncedCount !== null && Number.isFinite(syncedCount) ? (
          <div className="rounded-lg border border-success/30 bg-surface p-4 text-sm font-medium text-success">
            {t('messages.synced', { count: syncedCount })}
          </div>
        ) : null}

        {syncError ? (
          <div className="flex items-start gap-3 rounded-lg border border-danger/30 bg-surface p-4 text-danger">
            <AlertCircle aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
            <p className="text-sm font-medium">{t(`errors.${syncError}`)}</p>
          </div>
        ) : null}

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <PeriodControls
              activePeriod={activePeriod}
              from={from}
              labels={{
                apply: t('periods.custom'),
                from: t('periods.from'),
                presets: {
                  today: t('periods.today'),
                  yesterday: t('periods.yesterday'),
                  '7j': t('periods.7j'),
                  '30j': t('periods.30j'),
                  '90j': t('periods.90j'),
                },
                to: t('periods.to'),
              }}
              pathname="/commandes"
              presets={['today', 'yesterday', '7j', '30j']}
              searchParams={{
                period: params.period,
                q: params.q,
                shop: params.shop,
                vue: params.vue,
              }}
              to={to}
            />
            <ShopFilterSelector
              allLabel={t('shops.all')}
              ariaLabel={t('shops.ariaLabel')}
              label={t('shops.label')}
              pathname="/commandes"
              searchParams={{
                from: params.from,
                period: params.period,
                q: params.q,
                shop: params.shop,
                to: params.to,
                vue: params.vue,
              }}
              selectedShopId={selectedShopId}
              shops={shops}
            />
          </div>
        </div>

        {showWorkspace ? (
          <OrdersWorkspace
            activePeriod={activePeriod}
            activeView={activeView}
            canReassign={canReassign}
            dateFrom={from.toISOString()}
            dateTo={to.toISOString()}
            drivers={drivers}
            emptyValueLabel={t('table.emptyValue')}
            initialHasMore={pageData.hasMore}
            initialNextCursor={pageData.nextCursor}
            initialOrders={pageData.orders}
            initialReliabilityTiers={pageData.reliabilityTiers}
            reliabilityLabels={reliabilityLabels}
            searchLabels={{
              ariaLabel: t('search.ariaLabel'),
              clear: t('search.clear'),
              placeholder: t('search.placeholder'),
            }}
            searchQuery={search}
            selectedShopId={selectedShopId}
            views={viewCounts}
          />
        ) : null}

        {showNoShop || showNoOrdersWithShop || showFilteredEmpty ? (
          <EmptyState
            description={
              showNoShop
                ? t('empty.noShopDescription')
                : showNoOrdersWithShop
                  ? t('empty.withShopDescription')
                  : t('empty.filteredDescription')
            }
            illustration={<Store className="size-6" />}
            title={
              showNoShop
                ? t('empty.noShopTitle')
                : showNoOrdersWithShop
                  ? t('empty.withShopTitle')
                  : t('empty.filteredTitle')
            }
            action={
              showNoShop ? (
                <Link
                  className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-accent px-4 font-medium text-[#111]"
                  href="/boutiques"
                >
                  {t('empty.noShopCta')}
                  <ArrowRight aria-hidden="true" className="size-4" />
                </Link>
              ) : undefined
            }
          />
        ) : null}
      </main>
    </OrdersBoardProvider>
  );
}
