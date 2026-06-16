import { NewOrderForm } from '@/components/orders/new-order-form';
import { OrdersSearchInput } from '@/components/orders/orders-search-input';
import { OrdersWorkspace } from '@/components/orders/orders-workspace';
import { SyncOrdersButton } from '@/components/orders/sync-orders-button';
import { getActiveDrivers } from '@/lib/actions/drivers';
import { getMerchantAccount, getMerchantMemberForUser } from '@/lib/actions/merchant';
import { getOrdersPageData } from '@/lib/actions/orders';
import { getProductCatalogPageData } from '@/lib/actions/products';
import { getShopConnection } from '@/lib/actions/shopify';
import { orderSavedViews } from '@/lib/domain/order-saved-views';
import { normalizeOrderSearch } from '@/lib/orders/search';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AlertCircle, ArrowRight, Store } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

type CommandesPageProps = {
  searchParams: Promise<{
    q?: string;
    vue?: string;
    sync_error?: string;
    synced?: string;
  }>;
};

const syncErrorCodes = ['no_shop', 'sync_failed', 'token_error'] as const;
type SyncErrorCode = (typeof syncErrorCodes)[number];

function isSyncErrorCode(value: string): value is SyncErrorCode {
  return syncErrorCodes.includes(value as SyncErrorCode);
}

// Compte total des commandes du marchand (toutes vues, hors recherche), scopé
// par RLS. Sert uniquement à distinguer « compte vide » de « recherche sans
// résultat » ; on l'évite quand la recherche est vide (viewCounts.toutes suffit).
async function countAllOrders(): Promise<number> {
  const supabase = await createSupabaseServerClient();
  const { count } = await supabase.from('orders').select('id', { count: 'exact', head: true });
  return count ?? 0;
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
  const [pageData, shopConnection, merchant, productCatalog, drivers, canReassign] =
    await Promise.all([
      getOrdersPageData({ search, view: params.vue }),
      getShopConnection(),
      getMerchantAccount(),
      getProductCatalogPageData(),
      getActiveDrivers(),
      canReassignDrivers(),
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
  const totalOrders = search.length > 0 ? await countAllOrders() : searchedTotal;
  const visibleCount = pageData.viewCounts[activeView];
  const syncedCount = params.synced ? Number.parseInt(params.synced, 10) : null;
  const syncError =
    params.sync_error && isSyncErrorCode(params.sync_error) ? params.sync_error : null;
  const showNoShop = totalOrders === 0 && !shopConnection;
  const showNoOrdersWithShop = totalOrders === 0 && shopConnection;
  const showSearchEmpty = totalOrders > 0 && searchedTotal === 0 && search.length > 0;
  const showFilteredEmpty = searchedTotal > 0 && visibleCount === 0;
  const showWorkspace = totalOrders > 0;

  return (
    <main className="space-y-6" id="main">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <h1 className="font-display text-4xl md:text-5xl">{t('title')}</h1>
          <p className="max-w-2xl text-muted">{t('subtitle')}</p>
        </div>
        <div className="flex flex-col gap-3 sm:items-end">
          <NewOrderForm products={productOptions} />
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

      <OrdersSearchInput initialValue={search} />

      {showWorkspace ? (
        <OrdersWorkspace
          activeView={activeView}
          canReassign={canReassign}
          drivers={drivers}
          emptyValueLabel={t('table.emptyValue')}
          initialHasMore={pageData.hasMore}
          initialNextCursor={pageData.nextCursor}
          initialOrders={pageData.orders}
          initialReliabilityTiers={pageData.reliabilityTiers}
          merchantName={merchant?.name ?? 'Tëër'}
          reliabilityLabels={reliabilityLabels}
          searchQuery={search}
          views={viewCounts}
          whatsappMissingPhoneLabel={t('whatsapp.missingPhone')}
        />
      ) : null}

      {showNoShop || showNoOrdersWithShop || showSearchEmpty || showFilteredEmpty ? (
        <section className="rounded-lg border border-border bg-surface p-6 shadow-1">
          <div className="flex max-w-2xl flex-col gap-4 sm:flex-row sm:items-start">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-canvas text-accent">
              <Store aria-hidden="true" className="size-6" />
            </span>
            <div className="space-y-2">
              <h2 className="text-xl font-semibold">
                {showNoShop
                  ? t('empty.noShopTitle')
                  : showNoOrdersWithShop
                    ? t('empty.withShopTitle')
                    : showSearchEmpty
                      ? `Aucune commande pour "${params.q?.trim() ?? ''}"`
                      : t('empty.filteredTitle')}
              </h2>
              <p className="text-sm leading-6 text-muted">
                {showNoShop
                  ? t('empty.noShopDescription')
                  : showNoOrdersWithShop
                    ? t('empty.withShopDescription')
                    : showSearchEmpty
                      ? 'Essayez un autre nom, numero de telephone ou produit.'
                      : t('empty.filteredDescription')}
              </p>
              {showNoShop ? (
                <Link
                  className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-accent px-4 font-medium text-[#111]"
                  href="/boutiques"
                >
                  {t('empty.noShopCta')}
                  <ArrowRight aria-hidden="true" className="size-4" />
                </Link>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}
    </main>
  );
}
