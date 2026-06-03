import { CodStatusBadge } from '@/components/orders/cod-status-badge';
import { CustomerReliabilityBadge } from '@/components/orders/customer-reliability-badge';
import { NewOrderForm } from '@/components/orders/new-order-form';
import { OrderInlineActions } from '@/components/orders/order-inline-actions';
import { OrdersSearchInput } from '@/components/orders/orders-search-input';
import { OrdersViewChips } from '@/components/orders/orders-view-chips';
import { SyncOrdersButton } from '@/components/orders/sync-orders-button';
import { getMerchantAccount } from '@/lib/actions/merchant';
import { type OrderListItem, getOrders } from '@/lib/actions/orders';
import { getProductCatalogPageData } from '@/lib/actions/products';
import { getShopConnection } from '@/lib/actions/shopify';
import {
  compareOrdersForSavedView,
  matchesOrderSavedView,
  orderSavedViews,
  parseOrderSavedViewId,
} from '@/lib/domain/order-saved-views';
import { orderStatusLabels } from '@/lib/domain/order-state-machine';
import { formatDateRelative } from '@/lib/format/date';
import { formatMoney } from '@/lib/format/fcfa';
import { filterOrdersBySearch, normalizeOrderSearch } from '@/lib/orders/search';
import type { Database, Json } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { buildWhatsAppConfirmationUrl, firstName } from '@/lib/whatsapp/link';
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

type ReliabilityTier = 'new' | 'reliable' | 'risk' | 'watch';
type ReliabilityRow =
  Database['public']['Functions']['get_customer_reliability']['Returns'][number];

const syncErrorCodes = ['no_shop', 'sync_failed', 'token_error'] as const;
type SyncErrorCode = (typeof syncErrorCodes)[number];

function isSyncErrorCode(value: string): value is SyncErrorCode {
  return syncErrorCodes.includes(value as SyncErrorCode);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function formatOrderAddress(value: Json | null): string | null {
  if (!isRecord(value)) {
    return null;
  }

  const parts = [
    stringField(value, 'address1'),
    stringField(value, 'address2'),
    stringField(value, 'city'),
    stringField(value, 'province'),
    stringField(value, 'country'),
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(', ') : null;
}

function getCustomerReliabilityRpc(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
) {
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: 'get_customer_reliability',
    args: { p_customer_id: string; p_merchant_id: string },
  ) => Promise<{ data: ReliabilityRow[] | null; error: unknown }>;

  return rpc;
}

function isReliabilityTier(value: string | null): value is ReliabilityTier {
  return value === 'new' || value === 'reliable' || value === 'risk' || value === 'watch';
}

async function getReliabilityTiers(customerIds: string[]): Promise<Map<string, ReliabilityTier>> {
  const uniqueCustomerIds = [...new Set(customerIds)];

  if (uniqueCustomerIds.length === 0) {
    return new Map();
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return new Map();
  }

  const { data: memberRow } = await supabase
    .from('merchant_member')
    .select('merchant_account_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();
  const member = memberRow as { merchant_account_id: string } | null;

  if (!member) {
    return new Map();
  }

  const entries = await Promise.all(
    uniqueCustomerIds.map(async (customerId) => {
      const { data } = await getCustomerReliabilityRpc(supabase)('get_customer_reliability', {
        p_customer_id: customerId,
        p_merchant_id: member.merchant_account_id,
      });
      const tier = data?.[0]?.tier ?? null;

      return isReliabilityTier(tier) ? ([customerId, tier] as const) : null;
    }),
  );

  return new Map(entries.filter((entry): entry is readonly [string, ReliabilityTier] => !!entry));
}

function buildVisibleOrders(
  orders: OrderListItem[],
  activeView: ReturnType<typeof parseOrderSavedViewId>,
) {
  return orders
    .filter((order) => matchesOrderSavedView(order, activeView))
    .sort((left, right) => compareOrdersForSavedView(left, right, activeView));
}

export default async function CommandesPage({ searchParams }: CommandesPageProps) {
  const t = await getTranslations('orders');
  const clientsT = await getTranslations('clients');
  const params = await searchParams;
  const activeView = parseOrderSavedViewId(params.vue);
  const search = normalizeOrderSearch(params.q);
  const [orders, shopConnection, merchant, productCatalog] = await Promise.all([
    getOrders(),
    getShopConnection(),
    getMerchantAccount(),
    getProductCatalogPageData(),
  ]);
  const productOptions = productCatalog.ok
    ? productCatalog.products
        .filter((product) => product.is_active)
        .map((product) => ({
          id: product.id,
          sku: product.sku,
          title: product.title,
        }))
    : [];

  const searchedOrders = filterOrdersBySearch(orders, search);
  const visibleOrders = buildVisibleOrders(searchedOrders, activeView);
  const viewCounts = orderSavedViews.map((view) => ({
    id: view.id,
    label: view.label,
    count: searchedOrders.filter((order) => matchesOrderSavedView(order, view.id)).length,
  }));
  const reliabilityTiers =
    activeView === 'a-appeler'
      ? await getReliabilityTiers(
          visibleOrders
            .map((order) => order.customer_id)
            .filter((customerId): customerId is string => Boolean(customerId)),
        )
      : new Map<string, ReliabilityTier>();
  const reliabilityLabels = {
    new: clientsT('tiers.new'),
    reliable: clientsT('tiers.reliable'),
    risk: clientsT('tiers.risk'),
    watch: clientsT('tiers.watch'),
  };
  const syncedCount = params.synced ? Number.parseInt(params.synced, 10) : null;
  const syncError =
    params.sync_error && isSyncErrorCode(params.sync_error) ? params.sync_error : null;
  const showNoShop = orders.length === 0 && !shopConnection;
  const showNoOrdersWithShop = orders.length === 0 && shopConnection;
  const showSearchEmpty = orders.length > 0 && searchedOrders.length === 0 && search.length > 0;
  const showFilteredEmpty = searchedOrders.length > 0 && visibleOrders.length === 0;

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

      <OrdersViewChips activeView={activeView} views={viewCounts} />
      <OrdersSearchInput initialValue={search} />

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

      {visibleOrders.length > 0 ? (
        <section className="space-y-3">
          {visibleOrders.map((order) => (
            <article
              className="rounded-lg border border-border bg-surface p-4 shadow-1 transition-colors hover:bg-canvas/50"
              key={order.id}
            >
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <Link className="min-w-0 flex-1 space-y-3" href={`/commandes/${order.id}`}>
                  <div className="flex flex-wrap items-center gap-3">
                    <p className="font-mono text-sm font-semibold text-muted">
                      {order.order_number ?? t('table.emptyValue')}
                    </p>
                    <CodStatusBadge status={order.cod_status as keyof typeof orderStatusLabels} />
                    <span className="text-sm text-muted">
                      {orderStatusLabels[order.cod_status as keyof typeof orderStatusLabels]}
                    </span>
                  </div>

                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-base font-semibold">
                        {order.customer?.full_name ?? t('table.emptyValue')}
                      </p>
                      <CustomerReliabilityBadge
                        labels={reliabilityLabels}
                        tier={
                          order.customer_id
                            ? (reliabilityTiers.get(order.customer_id) ?? null)
                            : null
                        }
                      />
                    </div>
                    <p className="text-sm text-muted">
                      {formatDateRelative(order.created_at_shopify ?? order.created_at)}
                    </p>
                  </div>
                </Link>

                <div className="flex flex-col items-start gap-3 md:items-end">
                  <p className="text-lg font-semibold">
                    {formatMoney(order.total_amount, order.currency)}
                  </p>
                  <OrderInlineActions
                    allowedActions={order.allowedActions}
                    orderId={order.id}
                    phone={order.customer?.phone ?? null}
                    whatsappMissingPhoneLabel={t('whatsapp.missingPhone')}
                    whatsappUrl={buildWhatsAppConfirmationUrl({
                      address: formatOrderAddress(order.shipping_address),
                      currency: order.currency,
                      customerFirstName: firstName(order.customer?.full_name),
                      itemsSummary: order.items_summary,
                      orderNumber: order.order_number,
                      phone: order.customer?.phone ?? null,
                      shopName: merchant?.name ?? 'T\u00eb\u00ebr',
                      totalAmount: order.total_amount,
                    })}
                  />
                </div>
              </div>
            </article>
          ))}
        </section>
      ) : null}
    </main>
  );
}
